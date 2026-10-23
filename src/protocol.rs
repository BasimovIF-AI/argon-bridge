use serde::{Deserialize, Serialize};

/// Messages exchanged over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    // Extension interactions
    #[serde(rename = "EXECUTE_PROMPT")]
    ExecutePrompt {
        id: String,
        conversation_id: String,
        chat_url: Option<String>,
        model: String,
        prompt: String,
        timeout_secs: u64,
    },
    #[serde(rename = "PROMPT_RESPONSE")]
    PromptResponse {
        id: String,
        status: String, // "SUCCESS" | "ERROR" | "TIMEOUT"
        content: String,
        chat_url: Option<String>,
        error: Option<String>,
    },
    #[serde(rename = "STATUS_UPDATE")]
    StatusUpdate {
        connected: bool,
        active_tab_found: bool,
        current_chat_url: Option<String>,
        current_model: Option<String>,
    },
    #[serde(rename = "PING")]
    Ping {
        timestamp: i64,
    },
    #[serde(rename = "PONG")]
    Pong {
        timestamp: i64,
    },

    // CLI client interactions
    #[serde(rename = "CLI_EXECUTE")]
    CliExecute {
        id: String,
        conversation_id: Option<String>,
        prompt: String,
        new_chat: bool,
    },
    #[serde(rename = "CLI_RESPONSE")]
    CliResponse {
        id: String,
        status: String,
        content: String,
        chat_url: Option<String>,
        error: Option<String>,
    },
}

// ==========================================
// MCP (Model Context Protocol) JSON-RPC 2.0
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: serde_json::Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_message_serialization() {
        let msg = WsMessage::ExecutePrompt {
            id: "req-1".to_string(),
            conversation_id: "conv-1".to_string(),
            chat_url: Some("https://gemini.google.com/app/1".to_string()),
            model: "Gemini 4 Argon".to_string(),
            prompt: "Test code".to_string(),
            timeout_secs: 180,
        };

        let json_str = serde_json::to_string(&msg).expect("Serialize");
        assert!(json_str.contains("EXECUTE_PROMPT"));
        assert!(json_str.contains("Gemini 4 Argon"));

        let deserialized: WsMessage = serde_json::from_str(&json_str).expect("Deserialize");
        match deserialized {
            WsMessage::ExecutePrompt { id, prompt, .. } => {
                assert_eq!(id, "req-1");
                assert_eq!(prompt, "Test code");
            }
            _ => panic!("Wrong message variant"),
        }
    }

    #[test]
    fn test_mcp_response_json() {
        let resp = JsonRpcResponse::success(
            serde_json::json!(1),
            serde_json::json!({"status": "ok"}),
        );
        let serialized = serde_json::to_string(&resp).expect("Serialize");
        assert!(serialized.contains("\"result\":{\"status\":\"ok\"}"));
    }
}
