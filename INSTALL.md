# Install and run Elara on a Mac

## 1. Prepare the Mac

Elara requires an Apple silicon Mac running macOS 15 or newer. The default 35B A3B model is intended for a machine with ample unified memory. Install Google Chrome, Xcode Command Line Tools, and CMake:

```sh
xcode-select --install
brew install cmake
```

Install [oMLX](https://github.com/jundot/omlx), open it once, and add the MLX model you want to use. The default model name is `Qwen3.6-35B-A3B-4bit`. An existing LM Studio download is fine because the installer can link it into the oMLX model directory without copying the weights.

## 2. Install Elara

```sh
git clone --branch elara-mac https://github.com/MorarFS/elara-local-voice-assistant.git
cd elara-local-voice-assistant
./install-mac.sh
```

For an MLX model stored elsewhere:

```sh
ELARA_MODEL='Your-MLX-Model' \
ELARA_MODEL_PATH='/absolute/path/to/Your-MLX-Model' \
./install-mac.sh
```

Installation can take time because the script builds Whisper and downloads local speech models. It verifies the downloaded Node.js and Whisper model checksums before use.

If the terminal cannot find `elara` afterward, add this line to `~/.zprofile` and open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## 3. Start and stop

Run this from any directory:

```sh
elara
```

Elara opens in its own Chrome app window. The window behaves like a normal Mac app window and can be minimized. Use these maintenance commands:

```sh
elara status
elara restart
elara stop
elara models
elara model Swift-Qwen3.8-27b-mlx-5Bit
```

Elara discovers the models registered in oMLX each time it starts. Models that support at least 96,000 tokens use a 96,000-token context window. Models with a lower native limit use that limit. You can also click the current model below the chat composer to switch models in the app.

Always use `elara restart` if an older voice window is still open. It closes the Elara Chrome profile and releases the microphone before starting one clean instance.

## 4. Talk or type

Use the text box at the bottom of the chat for typed messages. Click the microphone to enter hands free mode. Grant microphone access to Google Chrome when macOS asks.

The **Conversation** panel stays visible during voice mode, so you can read your transcribed speech and Elara's replies, or type while the microphone is active. Click **Minimize chat** to hide the panel and **Show chat** to reopen it. Your draft stays in place.

Click **Attach documents** (the paperclip), or drag files into the chat panel. Wait for **Ready**, then speak your question or type it and press Enter. Shift+Enter inserts a new line. Documents are included with the next message; the remove button detaches a file before sending. Sending attachments without a question asks Elara to read them.

Supported files: PDF, Word `.docx`, UTF-8 text, Markdown, CSV, JSON, YAML, and LOG. Limits: five files per message, 15 MB per file, 200 PDF pages, and 500,000 extracted characters per document. Scanned PDFs require OCR first; password-protected PDFs need to be unlocked. Extraction reads text, so images and exact page layout are not included.

Originals and extracted text are stored in `.elara-documents` inside the conversation's workspace. Each prompt includes the first 12,000 characters per document and a local path for Elara's file tool to read the rest. Files remain available for follow-up questions; pending attachments that have not been sent need to be reattached after a page reload.

Elara defaults to the warm American `af_heart` Kokoro voice. Change the voice in **Settings → Add-ons → Voice**. Available packaged choices include Bella, Emma, Michael, and George.

## Update

Pull the branch and rerun the installer. Existing conversations, browser profile, password, model cache, and configuration in `~/Library/Application Support/Elara` are preserved.

```sh
cd elara-local-voice-assistant
git pull
./install-mac.sh
```

## Troubleshooting

### An older voice window is using the microphone

```sh
elara stop
elara
```

The stop command closes the dedicated Elara Chrome profile as well as the speech services.

### The microphone does not start

Open **System Settings → Privacy & Security → Microphone** and enable Google Chrome. Then run `elara restart`.

### Spoken replies are silent

Check that macOS output is set to the intended speakers and that Chrome is not muted. Close any older Elara tab and run:

```sh
elara restart
```

Kokoro health should be `true` in `elara status`.

### The Browser panel says port 3011 refused the connection

Update the repository and rerun `./install-mac.sh`. Elara on macOS uses its authenticated native Chrome viewer at `/browser-ui/`; it does not require the Linux KasmVNC service on port 3011.

### The model is not registered in oMLX

Make sure the chosen model appears in oMLX. Quit and reopen oMLX after adding a new model directory, then run `elara` again.

### Logs

Local logs are stored in:

```text
~/Library/Application Support/Elara/logs
```

No password or model weights belong in Git. The included `.gitignore` excludes runtime state, caches, credentials, and model directories.
