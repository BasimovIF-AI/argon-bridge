use crate::protocol::WsMessage;
use crate::session::SessionStore;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

pub type ResponseSender = oneshot::Sender<Result<(String, Option<String>), String>>;

#[derive(Debug, Clone)]
pub struct ExtensionStatus {
    pub connected: bool,
    pub active_tab_found: bool,
    pub current_chat_url: Option<String>,
    pub current_model: Option<String>,
}

impl Default for ExtensionStatus {
    fn default() -> Self {
        Self {
            connected: false,
            active_tab_found: false,
            current_chat_url: None,
            current_model: None,
        }
    }
}

#[derive(Clone)]
pub struct WebSocketHub {
    extension_tx: Arc<Mutex<Option<mpsc::UnboundedSender<Message>>>>,
    pending_prompts: Arc<Mutex<HashMap<String, ResponseSender>>>,
    pub status: Arc<RwLock<ExtensionStatus>>,
    sessions: SessionStore,
}

impl WebSocketHub {
    pub fn new(sessions: SessionStore) -> Self {
        Self {
            extension_tx: Arc::new(Mutex::new(None)),
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(RwLock::new(ExtensionStatus::default())),
            sessions,
        }
    }

    /// Check if at least one Chrome Extension client is currently connected.
    #[allow(dead_code)]
    pub async fn is_extension_connected(&self) -> bool {
        let lock = self.extension_tx.lock().await;
        lock.is_some()
    }

    /// Dispatch a prompt to the Chrome Extension and wait for completion.
    pub async fn execute_prompt(
        &self,
        id: String,
        conversation_id: String,
        chat_url: Option<String>,
        model: String,
        prompt: String,
        timeout_secs: u64,
    ) -> Result<(String, Option<String>), String> {
        let (resp_tx, resp_rx) = oneshot::channel();

        // 1. Register pending response
        {
            let mut pending = self.pending_prompts.lock().await;
            pending.insert(id.clone(), resp_tx);
        }

        // 2. Format message
        let msg = WsMessage::ExecutePrompt {
            id: id.clone(),
            conversation_id,
            chat_url,
            model,
            prompt,
            timeout_secs,
        };

        let json_str = match serde_json::to_string(&msg) {
            Ok(s) => s,
            Err(e) => {
                let mut pending = self.pending_prompts.lock().await;
                pending.remove(&id);
                return Err(format!("Serialization error: {}", e));
            }
        };

        // 3. Send over extension WebSocket
        {
            let lock = self.extension_tx.lock().await;
            if let Some(ref sender) = *lock {
                if let Err(e) = sender.send(Message::Text(json_str)) {
                    let mut pending = self.pending_prompts.lock().await;
                    pending.remove(&id);
                    return Err(format!("Failed to send frame to Chrome Extension: {}", e));
                }
            } else {
                let mut pending = self.pending_prompts.lock().await;
                pending.remove(&id);
                return Err("Chrome Extension is not connected. Open Chrome with the Gemini-Bridge extension on gemini.google.com".to_string());
            }
        }

        // 4. Await response with timeout
        match tokio::time::timeout(Duration::from_secs(timeout_secs), resp_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                let mut pending = self.pending_prompts.lock().await;
                pending.remove(&id);
                Err("Response channel closed prematurely by extension".to_string())
            }
            Err(_) => {
                let mut pending = self.pending_prompts.lock().await;
                pending.remove(&id);
                Err(format!("Timed out after {}s waiting for Gemini response", timeout_secs))
            }
        }
    }

    /// Start listening on ws://127.0.0.1:8765
    pub async fn start_server(self: Arc<Self>, bind_addr: SocketAddr) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(bind_addr).await?;
        info!("WebSocket server active on ws://{}", bind_addr);

        loop {
            match listener.accept().await {
                Ok((stream, client_addr)) => {
                    let hub_clone = self.clone();
                    tokio::spawn(async move {
                        hub_clone.handle_connection(stream, client_addr).await;
                    });
                }
                Err(e) => {
                    warn!("Failed to accept incoming connection: {}", e);
                }
            }
        }
    }

    async fn handle_connection(self: Arc<Self>, stream: TcpStream, addr: SocketAddr) {
        let ws_stream = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                error!("WebSocket handshake failed with {}: {}", addr, e);
                return;
            }
        };

        debug!("WebSocket connection accepted from {}", addr);
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Forward outgoing channel
        let send_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = ws_sender.send(msg).await {
                    debug!("Error sending WebSocket frame: {}", e);
                    break;
                }
            }
        });

        let mut is_extension_conn = false;
        let mut heartbeat_task: Option<tokio::task::JoinHandle<()>> = None;

        // Process incoming messages
        while let Some(msg_result) = ws_receiver.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    match serde_json::from_str::<WsMessage>(&text) {
                        Ok(WsMessage::StatusUpdate {
                            connected,
                            active_tab_found,
                            current_chat_url,
                            current_model,
                        }) => {
                            // First status update marks this as the Chrome extension connection
                            if !is_extension_conn {
                                is_extension_conn = true;
                                let mut lock = self.extension_tx.lock().await;
                                *lock = Some(tx.clone());
                                info!("Chrome Extension registered successfully from {}", addr);

                                // 15-second bidirectional heartbeat to keep Chrome MV3 Service Worker alive
                                let tx_hb = tx.clone();
                                heartbeat_task = Some(tokio::spawn(async move {
                                    let mut interval = tokio::time::interval(Duration::from_secs(15));
                                    loop {
                                        interval.tick().await;
                                        let ping_msg = WsMessage::Ping {
                                            timestamp: chrono::Utc::now().timestamp(),
                                        };
                                        if let Ok(json_str) = serde_json::to_string(&ping_msg) {
                                            if tx_hb.send(Message::Text(json_str)).is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }));
                            }
                            let mut st = self.status.write().await;
                            st.connected = connected;
                            st.active_tab_found = active_tab_found;
                            st.current_chat_url = current_chat_url;
                            st.current_model = current_model;
                        }

                        Ok(WsMessage::PromptResponse { id, status, content, chat_url, error }) => {
                            let mut pending = self.pending_prompts.lock().await;
                            if let Some(sender) = pending.remove(&id) {
                                if status == "SUCCESS" {
                                    let _ = sender.send(Ok((content, chat_url)));
                                } else {
                                    let err = error.unwrap_or_else(|| "Unknown extension error".to_string());
                                    let _ = sender.send(Err(err));
                                }
                            }
                        }

                        Ok(WsMessage::CliExecute { id, conversation_id, prompt, new_chat }) => {
                            let conv_id = conversation_id.unwrap_or_else(|| "cli_default".to_string());
                            let existing_chat_url = if new_chat {
                                self.sessions.remove_chat(&conv_id).await;
                                None
                            } else {
                                self.sessions.get_chat_url(&conv_id).await
                            };

                            info!("CLI request received (id: {}, conv: {})", id, conv_id);
                            let exec_id = Uuid::new_v4().to_string();
                            let result = self
                                .execute_prompt(
                                    exec_id,
                                    conv_id.clone(),
                                    existing_chat_url,
                                    "Gemini 4 Argon".to_string(),
                                    prompt,
                                    240,
                                )
                                .await;

                            let resp_msg = match result {
                                Ok((answer, new_url)) => {
                                    if let Some(url) = new_url.clone() {
                                        self.sessions.set_chat_url(&conv_id, &url).await;
                                    }
                                    WsMessage::CliResponse {
                                        id,
                                        status: "SUCCESS".to_string(),
                                        content: answer,
                                        chat_url: new_url,
                                        error: None,
                                    }
                                }
                                Err(e) => WsMessage::CliResponse {
                                    id,
                                    status: "ERROR".to_string(),
                                    content: String::new(),
                                    chat_url: None,
                                    error: Some(e),
                                },
                            };

                            if let Ok(resp_json) = serde_json::to_string(&resp_msg) {
                                let _ = tx.send(Message::Text(resp_json));
                            }
                        }

                        Ok(WsMessage::Ping { timestamp }) => {
                            let pong = WsMessage::Pong { timestamp };
                            if let Ok(pong_str) = serde_json::to_string(&pong) {
                                let _ = tx.send(Message::Text(pong_str));
                            }
                        }

                        _ => {}
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }

        if let Some(ref task) = heartbeat_task {
            task.abort();
        }
        send_task.abort();

        if is_extension_conn {
            let mut lock = self.extension_tx.lock().await;
            *lock = None;
            let mut st = self.status.write().await;
            st.connected = false;
            info!("Chrome Extension disconnected ({})", addr);
        }
    }
}
