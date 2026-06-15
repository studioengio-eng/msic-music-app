use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
struct ActiveTask {
    token: CancellationToken,
    abort_handle: AbortHandle,
}

#[derive(Debug, Default)]
pub struct TaskManager {
    active_extraction: Mutex<Option<ActiveTask>>,
}

impl TaskManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn cancel_active_extraction(&self) {
        let active = {
            let mut guard = self.active_extraction.lock().await;
            guard.take()
        };

        if let Some(active) = active {
            active.token.cancel();
            active.abort_handle.abort();
        }
    }

    pub async fn spawn_cancellable<T, Fut>(
        self: Arc<Self>,
        work: Fut,
    ) -> JoinHandle<Result<T, String>>
    where
        T: Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        self.cancel_active_extraction().await;

        let token = CancellationToken::new();
        let task_token = token.clone();
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = task_token.cancelled() => Err("Extracción cancelada por skip en serie".to_string()),
                result = work => result,
            }
        });

        let abort_handle = handle.abort_handle();
        {
            let mut guard = self.active_extraction.lock().await;
            *guard = Some(ActiveTask {
                token,
                abort_handle,
            });
        }

        handle
    }
}
