package com.msic.player

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player

/** Muestra anterior/siguiente en la notificación aunque solo haya una pista en ExoPlayer. */
class SkipControlsPlayer(player: Player) : ForwardingPlayer(player) {
    override fun getAvailableCommands(): Player.Commands {
        return super.getAvailableCommands()
            .buildUpon()
            .add(Player.COMMAND_SEEK_TO_NEXT)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .build()
    }

    override fun isCommandAvailable(command: Int): Boolean {
        if (command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_PREVIOUS) {
            return true
        }
        return super.isCommandAvailable(command)
    }
}
