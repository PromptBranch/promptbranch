# Connect AI providers

Connect a provider in the desktop app to run prompts, use AI prompt assist, or
judge results.

## Connect a provider

1. Open **Settings → AI Providers** and select **Connect a provider…**.
2. Choose OpenAI, Anthropic, Google, another listed provider, or **Custom
   OpenAI-compatible provider**.
3. Enter an API key, or choose **Use environment key** when PromptBranch finds
   a supported key in your environment.
4. For a custom provider, enter its base URL and a model to test.
5. Select **Connect**.

PromptBranch tests the connection before you use it. If the test fails, the
provider remains available so you can correct the details and try again.

## Use local models

For Ollama or LM Studio, choose **Custom OpenAI-compatible provider** and enter
the local server's OpenAI-compatible base URL. Then open **Manage models** in
AI Providers and add the model IDs you have installed or loaded. They will
appear in the run picker.

## Manage models

Use **Manage models** to hide models you do not use, restore hidden models, or
add model IDs for local endpoints. Standard providers show models from the
locally saved catalog when available.

## Your API keys

PromptBranch stores provider keys encrypted with your operating system's secure
storage. Keys are not included in library exports or copied to paired devices,
so configure them separately on each device.

Model runs and catalog refreshes need a network connection. Browsing and
editing your prompt library do not.
