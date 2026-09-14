# Docker add-ons

Pithagoras can install and manage **Browser** and **Voice** from **Settings → Add-ons**. Each runs in its own container on the same Docker host as Pithagoras. The portal talks directly to the host Docker API; no Docker CLI inside the portal and no Docker-in-Docker daemon are required.

This guide covers the managed Linux Docker installation. Add-ons are separate from [pi extensions](/guide/extensions) and [channel packages](/channels/index).

## 1. Give the portal Docker access

Use a Linux host with Docker Engine and Docker Compose. Keep these entries in the portal service:

```yaml
services:
  portal:
    # Keep the image/build, environment and other volumes from the shipped file.
    network_mode: host
    volumes:
      - portal-data:/data
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  portal-data:
```

This is a fragment to merge into your existing Compose file, not a replacement for it. Both shipped Compose files already mount the socket. It is required for managed add-ons **even with `EXECUTOR=host`**. The portal does not need `privileged: true` or a GPU reservation itself: the voice installer requests a GPU for the separate voice container.

Host networking is part of this setup: the portal connects to add-on services at the Docker host's loopback address. In an ordinary bridge-networked portal container, `127.0.0.1` means the portal container, so those managed endpoints will not work unchanged.

Apply a Compose change from the repository directory:

```sh
docker compose up -d --build portal
```

For Portainer, use `docker-compose.portainer.yml`, retain `network_mode: host` and the socket mount, set the required portal password, and **Update the stack**. That file calls the service `pithagoras`, not `portal`.

Verify API access from the running portal:

```sh
docker exec pithagoras curl --fail --unix-socket /var/run/docker.sock http://localhost/_ping
```

Expected response: `OK`. The official image runs as root. If you run it as a different user, grant that user access to the socket's host group instead of making the socket world-writable. A custom socket can be mounted and selected with the portal environment variable `DOCKER_SOCKET`.

The socket grants control of the Docker host, including creating containers and mounting host files. Keep the portal authenticated and on your trusted network; see [security](/guide/security). Do not expose an unauthenticated Docker TCP endpoint.

## 2. Prepare GPU access for Voice

Browser does not require an NVIDIA GPU. Automatic Voice setup requires a compatible NVIDIA GPU, a working host driver, and NVIDIA Container Toolkit configured for Docker. Reserve at least **30 GB of free disk space during setup**, plus enough system RAM and VRAM for the voice runtime alongside your LLM.

On the Docker host:

```sh
nvidia-smi
```

Install NVIDIA Container Toolkit using [NVIDIA's distribution-specific instructions](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). After installation, configure Docker and restart its daemon (this can affect running containers):

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify the same CUDA image used by the installer can access the GPU:

```sh
docker run --rm --gpus all nvidia/cuda:12.4.1-devel-ubuntu22.04 nvidia-smi
```

Continue only when this lists your GPU. In a VM or LXC, GPU access must already work inside the environment running Docker. The portal installer does not configure hypervisor passthrough or install host drivers.

The first installation needs internet access for container registries, Ubuntu packages, GitHub sources, and Hugging Face models. No Hugging Face token field is needed for the public models used by this installer.

## 3. Install Browser

1. Open **Settings → Add-ons → Browser**.
2. Enter a password for the browser web UI, or use the password generator. This is separate from the portal login password.
3. Click **Install** and wait for the image download and container startup.
4. Open the **Browser** page and verify the live browser appears. Log into sites there when needed; its profile persists.
5. Ask a session to use the browser.

The installer pulls `lscr.io/linuxserver/chromium:latest`, creates `pithagoras-browser`, and stores the browser profile in `pithagoras_browser-profile` (overridable with `BROWSER_VOLUME`). It uses host networking, 1 GiB shared memory, and Chromium's `seccomp=unconfined` setting. Defaults are HTTP `3010`, HTTPS `3011`, and debugging port `9222`; avoid conflicts with existing services. Keep browser/debugging ports private.

For embedded browser access, serve Pithagoras over HTTPS and follow the certificate setup in the [browser guide](/guide/browser). Voice microphone access also requires HTTPS, except on localhost.

### Browser controls

| Action | Result |
| --- | --- |
| **Stop** | Stops the browser container; keeps its profile and logins. |
| **Start** | Starts the installed container with that profile. |
| **Remove** | Deletes the container; keeps the profile volume. |
| **Install** after removal | Recreates the container and reuses a retained profile. |

Browser uses Docker's `unless-stopped` restart policy. If `BROWSER_EXTERNAL=true`, lifecycle management belongs to your external deployment; portal install/start/stop/remove actions are disabled by the server.

## 4. Install Voice

1. Open **Settings → Add-ons → Voice** and expand **Voice service**.
2. Click **Install voice**. Follow **Setup log** while the image downloads, sources build, and models download/quantize. First setup can take a long time; a running container is not yet a ready service.
3. Wait for **Ready**. The installer automatically enables voice and saves the managed endpoints once both services are healthy. **Use installed voice** reconnects those settings if you previously used custom endpoints.
4. Choose a **Speaking voice**, **Input language**, and **Speech generation** mode. Start with **Fast** for lower compute and VRAM demand; Expressive costs more.
5. Leave **Lazy load · release GPU memory when voice is idle** enabled unless you want to keep the model warm. Click **Save voice settings** after changing preferences.
6. Open a session, click the microphone, allow microphone access, and speak. The first connection loads Breeze into GPU memory.

The managed installer:

- Creates `pithagoras-voice` and the named volume `pithagoras_voice-models`, mounted at `/voice`.
- Builds pinned audio.cpp with CUDA and Whisper.cpp without CUDA. **Whisper runs on CPU**; Breeze uses one NVIDIA GPU.
- Downloads multilingual Whisper `base` and Breeze-TTS-2 BF16 GGUF, quantizes Breeze to **Q8_0** on CPU, verifies the generated file, then removes the BF16 source file after successful conversion.
- Retains source trees, compiled binaries and model files in the named volume.
- Starts both services with loopback-only host ports:

| Setting | Managed value |
| --- | --- |
| Speech runtime | **Breeze audio.cpp · streaming** |
| Whisper inference URL | `http://127.0.0.1:8188/inference` |
| Breeze speech URL | `http://127.0.0.1:7862/v1/audio/speech` |

Check readiness from the host:

```sh
curl --fail http://127.0.0.1:8188/health
curl --fail http://127.0.0.1:7862/health
```

A healthy service can have the TTS model unloaded: **Ready does not mean VRAM is already allocated**. Use **Add voice** in the voice library for your own designed or reference-cloned voice; installing the runtime does not install a personal Aria recording. See [voice control](/guide/voice) for voice references and speech detection settings.

### Voice controls and memory

| Action | Result |
| --- | --- |
| **Mute** in a voice session | Stops listening; keeps the voice session and spoken replies active. |
| **End** in a voice session | Releases that tab's connection; does not stop an accepted agent task. With lazy loading, the last released connection allows Breeze to unload. |
| **Start voice** | Starts the existing managed container, reusing its models. |
| **Retry setup** | Restarts a failed container and its setup script; retained downloads/builds are reused where the script can reuse them. |
| **Stop · release VRAM** | Stops both voice processes in the container, releasing their GPU allocations. Keeps model files. |
| Disable voice controls and save | Hides the session controls; it is not a container-uninstall operation. |

Lazy loading uses per-tab leases. Abandoned connections expire after 75 seconds and the portal checks every 30 seconds; audio.cpp also has a 90-second idle-unload setting. Do not expect a crashed tab to release memory instantly. With lazy loading off, the portal periodically requests the model remain loaded. Ending one tab does not release a model still used by another active tab.

The managed voice container has **no automatic Docker restart policy**. After a host reboot or service exit, use **Start voice** or **Retry setup**. Activating the microphone loads a model in a running service; it does not install or restart a stopped service.

## 5. Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Docker unavailable / permission denied | Run the socket `_ping` check above. Verify the mount and process permissions. Socket presence alone does not prove daemon access. |
| NVIDIA driver/device error | Run the CUDA `docker run --gpus all` check. Fix host driver, toolkit or passthrough before retrying Voice. |
| Setup stays at Starting | Expand Setup log or run `docker logs --tail 100 -f pithagoras-voice`; compilation and quantization happen after container startup. |
| Port already allocated | Check for older voice/browser containers using these ports. Stop the specific conflicting service before retrying. |
| Model load fails / weight buffer allocation fails | Run `nvidia-smi` and check other LLM/TTS processes. Stop duplicate voice services, reduce the LLM's GPU/context allocation or use Fast speech generation. Restart Voice after freeing memory. |
| No microphone prompt | Use HTTPS or localhost, grant browser permission, then restart voice mode. |
| HTTP 409 during speech | Another synthesis request owns the runtime. End the competing voice session and retry. |
| Portal rebuild did not update Voice | Add-on containers are managed separately; follow the recreate steps below. |

Useful host commands:

```sh
docker ps -a --filter name=pithagoras
docker logs --tail 100 pithagoras-browser
docker logs --tail 100 pithagoras-voice
nvidia-smi
docker volume inspect pithagoras_browser-profile pithagoras_voice-models
```

Do not run the old Python Breeze/Whisper Compose overlay or systemd units alongside the managed installer unless you deliberately maintain separate endpoints and enough resources. They are alternative deployments, not prerequisites; duplicate services can consume VRAM even after you stop the managed add-on.

## 6. Recreate, update or remove

Rebuilding the portal does not recreate its sibling add-on containers. Browser installation reuses an existing local image; to fetch a newer image, pull it explicitly, then **Remove → Install** in Settings:

```sh
docker pull lscr.io/linuxserver/chromium:latest
```

Voice's setup script is captured when its container is created. To apply a newer installer after updating the portal, end voice sessions, click **Stop · release VRAM**, and run:

```sh
docker rm pithagoras-voice
```

Then click **Install voice** again. Keep `pithagoras_voice-models` to reuse the models and builds; recreating is not a guarantee that every cached binary is rebuilt. The installer pins its runtime revisions rather than tracking upstream automatically.

Voice currently has no Remove button. To uninstall it while retaining downloads, stop it, run the same `docker rm` command, disable voice controls, and save. To also erase downloaded models, source trees and builds, run the following **only after stopping and removing the voice container**:

```sh
# Destructive: the next installation must download/build the voice runtime again.
docker volume rm pithagoras_voice-models
```

To erase browser logins, first click **Remove** in Settings, then delete the profile volume on the Docker host (substitute your configured `BROWSER_VOLUME` if different):

```sh
# Destructive: deletes the browser profile and saved logins.
docker volume rm pithagoras_browser-profile
```

The current Settings UI offers **Remove**, which preserves the profile; it does not expose the separate profile-deletion API as a button. Portal settings and uploaded voice references live separately in the portal's `/data` volume; do not delete that volume to reset an add-on. Named add-on volumes and containers are not part of the portal Compose lifecycle, so `docker compose down` does not stop or remove them.
