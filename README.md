# FAAAABot

Voice bot for Discord that joins your voice channel on command and plays a random "faaaaaa" sound.

## Setup

1. Create a Discord app/bot and invite it to your server with the `applications.commands` scope and permission to connect and speak.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy [./.env.example](.env.example) to `.env` and fill in:
   - `DISCORD_TOKEN`
   - `COMMAND_GUILD_ID` (optional, for instant command updates in one server)
4. Put your mp3 file at `audio/faaaaaa.mp3` or set `AUDIO_FILE_PATH` in `.env`.
5. Start the bot:
   ```bash
   npm start
   ```
6. In your server, run `/join` in chat while you are in the voice channel.
7. Run `/fa` to play the sound instantly (useful for testing).

## Commands

- `/join` - Join your current voice channel and start the random timer.
- `/fa` - Play the sound immediately and continue the random timer.
- `/status` - Show the current channel and next play time.
- `/leave` - Stop and leave the voice channel.

## Timing

Defaults are random 10s to 5m between plays, with a hard max of 30m without a sound.
Change any of these in `.env`:

- `MIN_DELAY_MS`
- `MAX_DELAY_MS`
- `HARD_MAX_MS`

yyy
