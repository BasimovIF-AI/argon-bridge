use crate::protocol::WsMessage;
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use std::fs;
use std::path::PathBuf;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(
    name = "gemini-bridge",
    version = "0.1.0",
    about = "High-performance bridge between Google Gemini Web (Gemini 4 Argon) and Antigravity AI Agent",
    author = "BasimovIF"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Verbose logging output
    #[arg(short, long, global = true)]
    pub verbose: bool,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Start the background daemon with WebSocket server for the Chrome Extension
    Serve {
        /// Port to bind the WebSocket server
        #[arg(short, long, default_value = "8765")]
        port: u16,
    },

    /// Run as a Model Context Protocol (MCP) server over stdio for Antigravity
    Mcp {
        /// Port to bind the background WebSocket server
        #[arg(short, long, default_value = "8765")]
        port: u16,
    },

    /// Send a prompt directly to Gemini 4 Argon from the command line
    Ask {
        /// Prompt text to send
        #[arg(short, long)]
        prompt: Option<String>,

        /// Path to a file containing prompt or source code context
        #[arg(short, long)]
        file: Option<PathBuf>,

        /// Specific conversation ID (defaults to 'cli_default')
        #[arg(short, long)]
        conversation_id: Option<String>,

        /// Force opening a fresh chat session instead of continuing previous
        #[arg(short, long)]
        new_chat: bool,

        /// WebSocket server URL
        #[arg(long, default_value = "ws://127.0.0.1:8765")]
        server: String,
    },

    /// Display current status of the bridge, extension, and session mappings
    Status {
        /// WebSocket server URL
        #[arg(long, default_value = "ws://127.0.0.1:8765")]
        server: String,
    },
}

impl Commands {
    pub async fn run_ask(
        prompt: Option<String>,
        file: Option<PathBuf>,
        conversation_id: Option<String>,
        new_chat: bool,
        server: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut final_prompt = String::new();

        if let Some(fpath) = file {
            let content = fs::read_to_string(&fpath)
                .map_err(|e| format!("Failed to read file {:?}: {}", fpath, e))?;
            final_prompt.push_str("### File Context:\n");
            final_prompt.push_str(&content);
            final_prompt.push_str("\n\n");
        }

        if let Some(p) = prompt {
            final_prompt.push_str(&p);
        }

        if final_prompt.trim().is_empty() {
            eprintln!("Error: Prompt is empty. Please provide --prompt or --file.");
            std::process::exit(1);
        }

        let (ws_stream, _) = match connect_async(&server).await {
            Ok(res) => res,
            Err(e) => {
                eprintln!("\n[!] Could not connect to Gemini-Bridge daemon at {}", server);
                eprintln!("[!] Please make sure 'gemini-bridge serve' is running, or Antigravity MCP is active.\nDetail: {}", e);
                std::process::exit(1);
            }
        };

        let (mut write, mut read) = ws_stream.split();
        let req_id = Uuid::new_v4().to_string();

        let cli_msg = WsMessage::CliExecute {
            id: req_id.clone(),
            conversation_id,
            prompt: final_prompt,
            new_chat,
        };

        let msg_str = serde_json::to_string(&cli_msg)?;
        write.send(Message::Text(msg_str)).await?;

        // Wait for response
        while let Some(msg_result) = read.next().await {
            match msg_result? {
                Message::Text(resp_text) => {
                    if let Ok(WsMessage::CliResponse { id, status, content, chat_url, error }) =
                        serde_json::from_str::<WsMessage>(&resp_text)
                    {
                        if id == req_id {
                            if status == "SUCCESS" {
                                if let Some(url) = chat_url {
                                    eprintln!("[Session URL: {}]", url);
                                }
                                println!("{}", content);
                                return Ok(());
                            } else {
                                eprintln!("Error: {}", error.unwrap_or_else(|| "Unknown failure".to_string()));
                                std::process::exit(1);
                            }
                        }
                    }
                }
                Message::Close(_) => {
                    eprintln!("Connection closed by server before receiving answer.");
                    std::process::exit(1);
                }
                _ => {}
            }
        }

        Ok(())
    }
}
