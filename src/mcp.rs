use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::session::SessionStore;
use crate::ws_server::WebSocketHub;
use serde_json::json;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, info, warn};
use uuid::Uuid;

pub struct McpServer {
    hub: Arc<WebSocketHub>,
    sessions: SessionStore,
}

impl McpServer {
    pub fn new(hub: Arc<WebSocketHub>, sessions: SessionStore) -> Self {
        Self { hub, sessions }
    }

    /// Run the MCP server over standard input and standard output.
    pub async fn run_stdio(self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        let mut reader = BufReader::new(stdin).lines();

        info!("MCP Server started listening on stdio");

        while let Some(line) = reader.next_line().await? {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            debug!("MCP Inbound: {}", trimmed);
            match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                Ok(req) => {
                    if let Some(resp) = self.handle_request(req).await {
                        let resp_str = serde_json::to_string(&resp)? + "\n";
                        stdout.write_all(resp_str.as_bytes()).await?;
                        stdout.flush().await?;
                    }
                }
                Err(e) => {
                    warn!("Malformed JSON-RPC request: {}", e);
                    let err_resp = JsonRpcResponse::error(serde_json::Value::Null, -32700, "Parse error");
                    let resp_str = serde_json::to_string(&err_resp)? + "\n";
                    stdout.write_all(resp_str.as_bytes()).await?;
                    stdout.flush().await?;
                }
            }
        }

        info!("MCP Server stdio stream closed");
        Ok(())
    }

    async fn handle_request(&self, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
        let req_id = match req.id {
            Some(id) => id,
            None => {
                // Notifications do not receive responses
                debug!("Handled notification: {}", req.method);
                return None;
            }
        };

        match req.method.as_str() {
            "initialize" => {
                let result = json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "gemini-bridge",
                        "version": "0.1.0"
                    }
                });
                Some(JsonRpcResponse::success(req_id, result))
            }

            "notifications/initialized" => None,

            "tools/list" => {
                let tools = json!({
                    "tools": [
                        {
                            "name": "ask_gemini_argon",
                            "description": "Consult Google Gemini 4 Argon for high-level architectural design, complex algorithms, system refactoring, concurrency, or in-depth code reviews. You (Antigravity Agent) act as the Builder executing tool calls and managing files; Gemini 4 Argon acts as the Chief Architect producing optimal solutions. Maintains 1:1 conversation context automatically.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "prompt": {
                                        "type": "string",
                                        "description": "The prompt or coding instruction for Gemini 4 Argon."
                                    },
                                    "context": {
                                        "type": "string",
                                        "description": "Optional context such as code files, error logs, or requirements."
                                    },
                                    "new_chat": {
                                        "type": "boolean",
                                        "description": "If true, starts a fresh chat session on Gemini instead of continuing the current conversation."
                                    },
                                    "conversation_id": {
                                        "type": "string",
                                        "description": "Optional custom conversation identifier. If omitted, uses active Antigravity session."
                                    }
                                },
                                "required": ["prompt"]
                            }
                        },
                        {
                            "name": "gemini_bridge_status",
                            "description": "Check connection status of the Chrome Extension, active Gemini tab, and current chat URL.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {}
                            }
                        },
                        {
                            "name": "new_gemini_chat",
                            "description": "Reset the Gemini chat association for the current Antigravity conversation so next prompt starts clean.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "conversation_id": {
                                        "type": "string",
                                        "description": "Optional conversation ID to reset."
                                    }
                                }
                            }
                        }
                    ]
                });
                Some(JsonRpcResponse::success(req_id, tools))
            }

            "tools/call" => {
                let params = req.params.unwrap_or(serde_json::Value::Null);
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));

                match tool_name {
                    "ask_gemini_argon" => {
                        let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                        let context = args.get("context").and_then(|v| v.as_str());
                        let force_new = args.get("new_chat").and_then(|v| v.as_bool()).unwrap_or(false);
                        let conv_id = args
                            .get("conversation_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| std::env::var("ANTIGRAVITY_CONVERSATION_ID").ok())
                            .unwrap_or_else(|| "default_session".to_string());

                        let full_prompt = match context {
                            Some(ctx) if !ctx.trim().is_empty() => {
                                format!("### Context / Source Files:\n{}\n\n### Task / Prompt:\n{}", ctx, prompt)
                            }
                            _ => prompt.to_string(),
                        };

                        let existing_chat_url = if force_new {
                            self.sessions.remove_chat(&conv_id).await;
                            None
                        } else {
                            self.sessions.get_chat_url(&conv_id).await
                        };

                        let request_id = Uuid::new_v4().to_string();
                        let result = self
                            .hub
                            .execute_prompt(
                                request_id,
                                conv_id.clone(),
                                existing_chat_url,
                                "Gemini 4 Argon".to_string(),
                                full_prompt,
                                240, // 4 minutes timeout for deep reasoning/code generation
                            )
                            .await;

                        match result {
                            Ok((answer, new_chat_url)) => {
                                if let Some(url) = new_chat_url {
                                    self.sessions.set_chat_url(&conv_id, &url).await;
                                }

                                let response_payload = json!({
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": answer
                                        }
                                    ]
                                });
                                Some(JsonRpcResponse::success(req_id, response_payload))
                            }
                            Err(e) => {
                                let error_payload = json!({
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": format!("Error from Gemini-Bridge: {}", e)
                                        }
                                    ],
                                    "isError": true
                                });
                                Some(JsonRpcResponse::success(req_id, error_payload))
                            }
                        }
                    }

                    "gemini_bridge_status" => {
                        let status_lock = self.hub.status.read().await;
                        let sessions_count = self.sessions.list_sessions().await.len();
                        let status_text = format!(
                            "Extension Connected: {}\nActive Tab Found: {}\nCurrent Chat URL: {:?}\nCurrent Model: {:?}\nActive Mapped Sessions: {}",
                            status_lock.connected,
                            status_lock.active_tab_found,
                            status_lock.current_chat_url,
                            status_lock.current_model,
                            sessions_count
                        );
                        let response_payload = json!({
                            "content": [
                                {
                                    "type": "text",
                                    "text": status_text
                                }
                            ]
                        });
                        Some(JsonRpcResponse::success(req_id, response_payload))
                    }

                    "new_gemini_chat" => {
                        let conv_id = args
                            .get("conversation_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| std::env::var("ANTIGRAVITY_CONVERSATION_ID").ok())
                            .unwrap_or_else(|| "default_session".to_string());

                        self.sessions.remove_chat(&conv_id).await;
                        let response_payload = json!({
                            "content": [
                                {
                                    "type": "text",
                                    "text": format!("Session for conversation '{}' reset. Next message will open a new chat on Gemini.", conv_id)
                                }
                            ]
                        });
                        Some(JsonRpcResponse::success(req_id, response_payload))
                    }

                    _ => Some(JsonRpcResponse::error(
                        req_id,
                        -32601,
                        format!("Unknown tool: {}", tool_name),
                    )),
                }
            }

            _ => Some(JsonRpcResponse::error(
                req_id,
                -32601,
                format!("Method not found: {}", req.method),
            )),
        }
    }
}
