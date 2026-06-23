package com.msic.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.webkit.WebView

/** Puente nativo → WebView para controles y sincronización UI. */
object PlaybackBridge {
    private var webView: WebView? = null
    private val handler = Handler(Looper.getMainLooper())

    @Volatile
    private var backgroundPlaybackActive = false

    @Volatile
    private var pendingEnded = false

    @Volatile
    private var pendingTrackChanged = false

    private var retryAttempt = 0
    private var trackChangedRetry = 0
    private val maxRetries = 40

    private var wakeLock: PowerManager.WakeLock? = null

    private val endedScript = """
        (function(){
          if (window.MediaEventBridge && typeof window.MediaEventBridge.onEnded === 'function') {
            window.MediaEventBridge.onEnded();
            return true;
          }
          window.dispatchEvent(new Event('msic-playback-ended'));
          return true;
        })();
    """.trimIndent()

    fun register(view: WebView) {
        webView = view
        val context = view.context
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MSIC::TransitionWakeLock")
        wakeLock?.setReferenceCounted(false)
    }

    fun clear() {
        webView = null
        wakeLock = null
        pendingEnded = false
        retryAttempt = 0
    }

    fun setBackgroundPlaybackActive(active: Boolean) {
        backgroundPlaybackActive = active
        if (active) {
            webView?.onResume()
        }
    }

    /** Mantener timers JS activos mientras suena música en segundo plano. */
    fun onActivityPause() {
        if (!backgroundPlaybackActive) return
        webView?.onResume()
        if (pendingEnded) {
            dispatchEndedToWebView(0)
        }
        if (pendingTrackChanged) {
            dispatchTrackChangedToWebView(0)
        }
    }

    fun onActivityResume() {
        if (pendingEnded) {
            dispatchEndedToWebView(0)
        }
        if (pendingTrackChanged) {
            dispatchTrackChangedToWebView(0)
        }
    }

    fun onPlaybackEnded() {
        pendingEnded = true
        retryAttempt = 0
        wakeLock?.acquire(15000L) // Mantener CPU despierto 15s para que JS cargue la siguiente pista
        dispatchEndedToWebView(0)
    }

    fun clearPendingEnded() {
        pendingEnded = false
        retryAttempt = maxRetries
    }

    fun notifyTrackChanged() {
        pendingTrackChanged = true
        trackChangedRetry = 0
        dispatchTrackChangedToWebView(0)
    }

    fun clearPendingTrackChanged() {
        pendingTrackChanged = false
        trackChangedRetry = maxRetries
    }

    private val trackChangedScript = """
        (function(){
          if (window.MediaEventBridge && typeof window.MediaEventBridge.onTrackChanged === 'function') {
            window.MediaEventBridge.onTrackChanged();
            return true;
          }
          return false;
        })();
    """.trimIndent()

    private fun dispatchTrackChangedToWebView(attempt: Int) {
        val view = webView
        if (view == null) {
            if (pendingTrackChanged && attempt < maxRetries) {
                scheduleTrackChangedRetry(attempt + 1)
            }
            return
        }
        view.post {
            try {
                view.evaluateJavascript(trackChangedScript) { result ->
                    if (result == "true") {
                        clearPendingTrackChanged()
                    } else {
                        if (pendingTrackChanged && attempt < maxRetries) {
                            scheduleTrackChangedRetry(attempt + 1)
                        }
                    }
                }
            } catch (_: Exception) {
                if (pendingTrackChanged && attempt < maxRetries) {
                    scheduleTrackChangedRetry(attempt + 1)
                }
            }
            if (backgroundPlaybackActive) {
                view.onResume()
            }
        }
    }

    private fun scheduleTrackChangedRetry(nextAttempt: Int) {
        trackChangedRetry = nextAttempt
        if (!pendingTrackChanged || nextAttempt >= maxRetries) return
        handler.postDelayed({ dispatchTrackChangedToWebView(nextAttempt) }, 500L)
    }

    private fun dispatchEndedToWebView(attempt: Int) {
        val view = webView
        if (view == null) {
            if (pendingEnded && attempt < maxRetries) {
                scheduleRetry(attempt + 1)
            }
            return
        }

        view.post {
            try {
                view.evaluateJavascript(endedScript) { result ->
                    if (result == "true") {
                        clearPendingEnded()
                    } else {
                        if (pendingEnded && attempt < maxRetries) {
                            scheduleRetry(attempt + 1)
                        }
                    }
                }
            } catch (_: Exception) {
                if (pendingEnded && attempt < maxRetries) {
                    scheduleRetry(attempt + 1)
                }
            }
            if (backgroundPlaybackActive) {
                view.onResume()
            }
        }
    }

    private fun scheduleRetry(nextAttempt: Int) {
        retryAttempt = nextAttempt
        if (!pendingEnded || nextAttempt >= maxRetries) return
        handler.postDelayed({ dispatchEndedToWebView(nextAttempt) }, 400L)
    }

    private fun runJs(script: String) {
        val view = webView ?: return
        view.post {
            try {
                view.evaluateJavascript(script, null)
            } catch (_: Exception) {
                /* ignore */
            }
        }
    }

    fun onSkipNext() {
        runJs(
            """
            (function(){
              if (window.MediaEventBridge && typeof window.MediaEventBridge.next === 'function') {
                window.MediaEventBridge.next();
              }
            })();
            """.trimIndent()
        )
    }

    fun onSkipPrevious() {
        runJs(
            """
            (function(){
              if (window.MediaEventBridge && typeof window.MediaEventBridge.previous === 'function') {
                window.MediaEventBridge.previous();
              }
            })();
            """.trimIndent()
        )
    }
}
