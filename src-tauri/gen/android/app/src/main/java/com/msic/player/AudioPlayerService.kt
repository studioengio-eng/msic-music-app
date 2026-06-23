package com.msic.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

@UnstableApi
class AudioPlayerService : MediaSessionService() {
    private var mediaSession: MediaSession? = null
    private var player: ExoPlayer? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var currentAudioFocusState = AudioManager.AUDIOFOCUS_NONE

    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                currentAudioFocusState = AudioManager.AUDIOFOCUS_GAIN
                player?.volume = 1f
                if (player?.isPlaying != true) {
                    player?.play()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                currentAudioFocusState = AudioManager.AUDIOFOCUS_LOSS
                player?.pause()
                player?.volume = 1f
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                currentAudioFocusState = AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                if (player?.isPlaying() == true) {
                    player?.pause()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                currentAudioFocusState = AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
                player?.volume = 0.2f
            }
        }
    }

    private val bluetoothReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioManager.ACTION_AUDIO_BECOMING_NOISY -> {
                    if (player?.isPlaying() == true) {
                        player?.pause()
                    }
                }
                Intent.ACTION_HEADSET_PLUG -> {
                    val state = intent.getIntExtra("state", -1)
                    if (state == 1 && currentAudioFocusState == AudioManager.AUDIOFOCUS_GAIN) {
                        player?.play()
                    }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        AudioOutputManager.initialize(this)

        val audioAttributes = AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .setUsage(C.USAGE_MEDIA)
            .build()

        val exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()

        player = exoPlayer
        PlayerManager.initialize(this, exoPlayer)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .build()
        }

        val filter = IntentFilter().apply {
            addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            addAction(Intent.ACTION_HEADSET_PLUG)
        }
        registerReceiver(bluetoothReceiver, filter)

        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playerWithSkipControls = SkipControlsPlayer(exoPlayer)
        mediaSession = MediaSession.Builder(this, playerWithSkipControls)
            .setSessionActivity(pendingIntent)
            .setCallback(object : MediaSession.Callback {
                override fun onConnect(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo
                ): MediaSession.ConnectionResult {
                    return MediaSession.ConnectionResult.accept(
                        MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS,
                        MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
                    )
                }

                override fun onCustomCommand(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    customCommand: SessionCommand,
                    args: Bundle
                ): ListenableFuture<SessionResult> {
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }

                override fun onPlayerCommandRequest(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    playerCommand: Int
                ): Int {
                    // Route skip commands from lock screen / notification
                    when (playerCommand) {
                        Player.COMMAND_SEEK_TO_NEXT,
                        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> {
                            if (QueueManager.hasNext(forceNext = true)) {
                                PlayerManager.playNextInQueue(forceNext = true)
                                PlaybackBridge.notifyTrackChanged()
                            } else {
                                PlaybackBridge.onSkipNext()
                            }
                            return SessionResult.RESULT_SUCCESS
                        }
                        Player.COMMAND_SEEK_TO_PREVIOUS,
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
                            val prev = QueueManager.previousTrack()
                            if (prev != null) {
                                PlayerManager.playTrack(prev)
                                PlaybackBridge.notifyTrackChanged()
                            } else {
                                PlaybackBridge.onSkipPrevious()
                            }
                            return SessionResult.RESULT_SUCCESS
                        }
                    }
                    return SessionResult.RESULT_SUCCESS
                }
            })
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = player
        if (p != null && p.playbackState != Player.STATE_ENDED && p.playbackState != Player.STATE_IDLE) {
            val intent = Intent(this, AudioPlayerService::class.java)
            startService(intent)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        abandonAudioFocus()
        try {
            unregisterReceiver(bluetoothReceiver)
        } catch (_: Exception) {}

        AudioOutputManager.release()
        mediaSession?.release()
        mediaSession = null
        player?.release()
        player = null
        PlayerManager.release()
        super.onDestroy()
    }

    fun requestAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { request ->
                val result = am.requestAudioFocus(request)
                currentAudioFocusState = when (result) {
                    AudioManager.AUDIOFOCUS_GAIN -> AudioManager.AUDIOFOCUS_GAIN
                    else -> AudioManager.AUDIOFOCUS_LOSS
                }
            }
        } else {
            @Suppress("DEPRECATION")
            val result = am.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
            currentAudioFocusState = when (result) {
                AudioManager.AUDIOFOCUS_GAIN -> AudioManager.AUDIOFOCUS_GAIN
                else -> AudioManager.AUDIOFOCUS_LOSS
            }
        }
    }

    private fun abandonAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(audioFocusChangeListener)
        }
        currentAudioFocusState = AudioManager.AUDIOFOCUS_NONE
    }
}
