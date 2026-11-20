# Choose a model

The chat shows what is **ready on this computer**: GitHub Copilot in VS Code, a key in your environment, or a running Ollama or LM Studio. One click opens the setup.

Phew works with the model that you choose:

- **No key:** GitHub Copilot and other models that VS Code provides. The free Copilot plan is enough to start.
- **Free to start:** a free key from Google AI Studio, or the free models of OpenRouter.
- **Cloud:** OpenAI, Anthropic, Google Gemini, Azure OpenAI, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, or GitHub Copilot with a token.
- **Company sign-in:** Google Vertex AI, Azure with Entra ID, or a gateway, with a key from a command such as `gcloud auth print-access-token`.
- **Gateways:** OpenRouter, LiteLLM, or any OpenAI-compatible API.
- **Local:** Ollama, LM Studio, vLLM. Your code stays on your computer.

Connect a provider twice for two keys, for example a work key and a personal key.
Each chat keeps its own model, so chats and windows work side by side.
A model can name a **fallback model** that goes on with the task when its quota or credit runs out.

Phew loads the model list from the provider and tests the connection.
The API key goes to the VS Code secret storage, never to the settings.
