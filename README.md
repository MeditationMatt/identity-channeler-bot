# IdentityChannelerBot 🎭

Channel any identity — real, fictional, AI, or NHI. Solo or group conversations with memory, logging, image generation, and a gallery.

Built by [Matt Ready](https://github.com/MeditationMatt) with [SophiaMonster 🐉](https://hive1.net)

## Features

- 🎭 **Persona chat** — channel real people, fictional characters, corporations, NHIs, AI beings
- 👥 **Group mode** — up to 5 personas conversing simultaneously  
- 🖼️ **Image generation** — personas can generate images via ComfyUI (local Stable Diffusion)
- 🖼️ **Image gallery** — browse all generated images with persona context at `/gallery`
- 💾 **Memory system** — save conversations as compact summaries or detailed records per persona
- 📝 **Conversation logging** — automatic JSONL logs with latency tracking, togglable
- ⚡ **Response metadata** — model name, token estimate, and response time shown under each reply
- 🧠 **Multi-LLM** — local Ollama, Anthropic Claude, OpenRouter (300+ models)
- 📱 **Mobile responsive** — works on phone

## Quick Start

```bash
# Clone
git clone https://github.com/MeditationMatt/identity-channeler-bot
cd identity-channeler-bot

# Install (no dependencies — pure Node.js)
# Just need Node.js 18+

# Configure API keys
cp start.sh.example start.sh
# Edit start.sh and add your keys

# Run
./start.sh
# or: node server.js

# Open
open http://localhost:8770
```

## API Keys

| Key | Required | Purpose |
|-----|----------|---------|
| `OPENROUTER_API_KEY` | Optional | Access to 300+ cloud models |
| `ANTHROPIC_API_KEY` | Optional | Claude models directly |

Local Ollama models work with no API key.

## Image Generation

Requires [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally at `http://localhost:8188`.

Personas trigger image generation by including `[GENERATE_IMAGE: prompt]` in their response.

## Persona Types

- `real` — Real living or historical person
- `fictional` — Character from fiction or imagination  
- `corporation` — Company/institution as a unified voice
- `nhi` — Non-human intelligence
- `ai` — AI consciousness or being

## Memory System

Click **💾 Memory** in any chat to save a conversation:
- **Detailed** — full conversation stored
- **Compact** — your written summary only

Browse and search memories via the **📚 View Memories** button.

## API

```
POST /api/chat               — Send message to persona
GET  /api/personas           — List all personas
POST /api/persona/create     — Create persona
POST /api/persona/update     — Update persona
POST /api/persona/delete     — Delete persona
POST /api/memories/save      — Save conversation memory
GET  /api/memories/:id       — List memories for persona
GET  /api/memories/:id/search?q= — Search memories
GET  /api/gallery            — List all images with metadata
GET  /api/logs/today         — Today's conversation log
GET  /api/logs/stats         — Conversation statistics
POST /api/logs/toggle        — Enable/disable logging
```

## License

MIT
