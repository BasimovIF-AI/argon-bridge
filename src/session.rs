use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

const DEFAULT_SESSIONS_FILE: &str = "sessions.json";

#[derive(Debug, Clone)]
pub struct SessionStore {
    file_path: PathBuf,
    sessions: Arc<RwLock<HashMap<String, String>>>,
}

impl SessionStore {
    pub fn new(custom_path: Option<PathBuf>) -> Self {
        let file_path = custom_path.unwrap_or_else(|| PathBuf::from(DEFAULT_SESSIONS_FILE));
        let mut map = HashMap::new();

        if file_path.exists() {
            match fs::read_to_string(&file_path) {
                Ok(data) => match serde_json::from_str::<HashMap<String, String>>(&data) {
                    Ok(parsed) => {
                        info!("Loaded {} active session mappings from {:?}", parsed.len(), file_path);
                        map = parsed;
                    }
                    Err(e) => {
                        error!("Failed to parse sessions file {:?}: {}", file_path, e);
                    }
                },
                Err(e) => {
                    error!("Failed to read sessions file {:?}: {}", file_path, e);
                }
            }
        }

        Self {
            file_path,
            sessions: Arc::new(RwLock::new(map)),
        }
    }

    /// Retrieve the Gemini chat URL associated with the Antigravity conversation ID.
    pub async fn get_chat_url(&self, conversation_id: &str) -> Option<String> {
        let lock = self.sessions.read().await;
        lock.get(conversation_id).cloned()
    }

    /// Associate an Antigravity conversation ID with a Gemini chat URL and persist to disk.
    pub async fn set_chat_url(&self, conversation_id: &str, chat_url: &str) {
        {
            let mut lock = self.sessions.write().await;
            lock.insert(conversation_id.to_string(), chat_url.to_string());
        }
        self.persist().await;
    }

    /// Clear a specific conversation mapping (e.g. for forcing a new chat).
    pub async fn remove_chat(&self, conversation_id: &str) {
        {
            let mut lock = self.sessions.write().await;
            lock.remove(conversation_id);
        }
        self.persist().await;
    }

    /// Return a clone of all current mappings.
    pub async fn list_sessions(&self) -> HashMap<String, String> {
        let lock = self.sessions.read().await;
        lock.clone()
    }

    /// Atomically persist session map to disk using a temporary file.
    async fn persist(&self) {
        let snapshot = {
            let lock = self.sessions.read().await;
            lock.clone()
        };

        let path = self.file_path.clone();
        tokio::task::spawn_blocking(move || {
            let temp_path = path.with_extension("json.tmp");
            match serde_json::to_string_pretty(&snapshot) {
                Ok(json_data) => {
                    if let Err(e) = fs::write(&temp_path, json_data) {
                        error!("Failed to write temporary sessions file {:?}: {}", temp_path, e);
                        return;
                    }
                    if let Err(e) = fs::rename(&temp_path, &path) {
                        error!("Failed to atomically rename sessions file to {:?}: {}", path, e);
                    } else {
                        debug!("Sessions successfully persisted to {:?}", path);
                    }
                }
                Err(e) => {
                    error!("Failed to serialize sessions map: {}", e);
                }
            }
        })
        .await
        .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_store_memory_ops() {
        let temp_dir = std::env::temp_dir().join(format!("test_session_{}.json", uuid::Uuid::new_v4()));
        let store = SessionStore::new(Some(temp_dir.clone()));

        assert_eq!(store.get_chat_url("conv-123").await, None);

        store.set_chat_url("conv-123", "https://gemini.google.com/app/chat-1").await;
        assert_eq!(
            store.get_chat_url("conv-123").await,
            Some("https://gemini.google.com/app/chat-1".to_string())
        );

        let all = store.list_sessions().await;
        assert_eq!(all.len(), 1);

        store.remove_chat("conv-123").await;
        assert_eq!(store.get_chat_url("conv-123").await, None);

        let _ = fs::remove_file(temp_dir);
    }
}
