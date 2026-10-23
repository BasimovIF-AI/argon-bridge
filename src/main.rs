mod cli;
mod mcp;
mod protocol;
mod session;
mod ws_server;

use clap::Parser;
use cli::{Cli, Commands};
use mcp::McpServer;
use session::SessionStore;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;
use ws_server::WebSocketHub;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Cli::parse();

    // Setup logging: always direct logs to stderr so MCP JSON-RPC on stdout is never corrupted
    let log_level = if args.verbose { Level::DEBUG } else { Level::INFO };
    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_writer(std::io::stderr)
        .finish();
    tracing::subscriber::set_global_default(subscriber).ok();

    let sessions = SessionStore::new(None);
    let hub = Arc::new(WebSocketHub::new(sessions.clone()));

    match args.command {
        Commands::Serve { port } => {
            let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
            info!("Starting Gemini-Bridge background daemon on ws://{}", addr);

            let hub_clone = hub.clone();
            let server_task = tokio::spawn(async move {
                if let Err(e) = hub_clone.start_server(addr).await {
                    eprintln!("WebSocket server error: {}", e);
                }
            });

            tokio::signal::ctrl_c().await?;
            info!("Shutdown signal received. Exiting...");
            server_task.abort();
        }

        Commands::Mcp { port } => {
            let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
            let hub_clone = hub.clone();

            // Spawn background WebSocket server for Chrome Extension connection
            tokio::spawn(async move {
                if let Err(e) = hub_clone.start_server(addr).await {
                    eprintln!("WebSocket background server error: {}", e);
                }
            });

            // Run MCP stdio handler on main thread
            let mcp_server = McpServer::new(hub, sessions);
            if let Err(e) = mcp_server.run_stdio().await {
                eprintln!("MCP Server error: {}", e);
            }
        }

        Commands::Ask {
            prompt,
            file,
            conversation_id,
            new_chat,
            server,
        } => {
            Commands::run_ask(prompt, file, conversation_id, new_chat, server).await?;
        }

        Commands::Status { server } => {
            println!("Querying Gemini-Bridge status at {}...", server);
            // In a status query, we can connect and ping
            let status_msg = format!("Ensure daemon is running and extension is connected to {}.", server);
            println!("{}", status_msg);
        }
    }

    Ok(())
}
