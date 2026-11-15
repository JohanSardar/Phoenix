# Model

`ModelProvider.complete({ system, prompt, signal? })` makes one stateless text request. `HttpModelProvider` adapts the `messages`, `chat-completions`, `responses` and `generate-content` dialects. Supply the exact inference endpoint, model id, token limit and optional temperature, with authentication/version/routing headers separately. The endpoint must not contain credentials or a query. Credentials never enter `configuration`, cache keys or errors; provider error bodies are not surfaced.

Each request contains only the supplied system instruction and prompt. No tools, conversation ids, prior responses or history are retained. Responses requests explicitly disable storage. The caller owns credential lookup; the core names no provider. `configuration` is immutable and identifies output-affecting settings for the simulator cache.
