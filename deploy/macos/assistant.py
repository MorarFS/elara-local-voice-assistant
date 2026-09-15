#!/usr/bin/env python3
"""Start and stop only this local assistant's processes. No microphone capture."""
from pathlib import Path
import argparse, fcntl, http.cookiejar, json, os, signal, subprocess, sys, time, urllib.request, urllib.error

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
NODE = ROOT / 'runtime/node/bin/node'
LMS = Path.home() / '.lmstudio/bin/lms'
PORTAL = 'http://127.0.0.1:4100'

def read_config():
    return json.loads((ROOT / 'config/assistant.json').read_text())

def environment():
    env = os.environ.copy()
    for key in list(env):
        if key.endswith('_API_KEY') or key in ('ANTHROPIC_AUTH_TOKEN', 'OPENAI_ACCESS_TOKEN'):
            env.pop(key, None)
    secrets = json.loads((ROOT / 'config/secrets.json').read_text())
    env.update({
        'PATH': str(ROOT / 'runtime/node/bin') + ':' + str(APP / 'node_modules/.bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + str(Path.home() / '.local/bin'),
        'PORT': '4100', 'PORTAL_HOST': '127.0.0.1', 'NODE_ENV': 'production',
        'PORTAL_SECRET': secrets['portal_secret'],
        'DATA_DIR': str(ROOT / 'data'), 'SESSION_DIR': str(ROOT / 'data/sessions'),
        'WORKSPACE_ROOT': str(ROOT / 'workspaces'), 'AGENT_HOME': str(ROOT / 'workspaces'),
        'BIN_DIR': str(ROOT / 'runtime'), 'CHANNELS_DIR': str(ROOT / 'data/channels'),
        'PI_CODING_AGENT_DIR': str(ROOT / 'agent'), 'PI_PROVIDER': read_config().get('provider', 'omlx'),
        'PI_MODEL': read_config()['model'], 'PI_THINKING_LEVEL': 'off',
        'npm_config_offline': 'true',
        'EXECUTOR': 'host', 'ELARA_ROOT': str(ROOT), 'VOICE_NATIVE_DIR': str(ROOT), 'VOICE_NATIVE_PYTHON': sys.executable,
        'VOICE_PIPELINE_MODE': 'parallel', 'VOICE_SENTENCE_CHUNKS': 'true',
        'VOICE_TTS_PREFETCH': 'true', 'VOICE_SKIP_FIRST_THINKING': 'true',
        'VOICE_RESPONSE_INSTRUCTIONS': 'true', 'VOICE_STATUS_SPEECH': 'false',
        'BROWSER_CDP_URL': 'http://127.0.0.1:9222', 'BROWSER_NATIVE_UI': 'true', 'TZ': 'Asia/Hong_Kong',
    })
    omlx = json.loads((Path.home() / '.omlx/settings.json').read_text())
    env['OMLX_API_KEY'] = omlx['auth']['api_key']
    return env

def reachable(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False

def process_alive(name):
    record = ROOT / 'data' / (name + '.pid.json')
    try:
        data = json.loads(record.read_text())
        args = subprocess.check_output(['/bin/ps', '-p', str(data['pid']), '-o', 'command='], text=True).strip()
        return data if data['marker'] in args and os.getpgid(data['pid']) == data['pid'] else None
    except Exception:
        return None

def start_process(name, argv, marker, url):
    if process_alive(name) and reachable(url):
        return
    if reachable(url):
        raise RuntimeError('Port is already occupied by a process not started by this assistant: ' + name)
    if process_alive(name):
        stop_process(name)
    with (ROOT / 'logs' / (name + '.log')).open('ab') as log:
        child = subprocess.Popen(argv, cwd=APP, env=environment(), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    (ROOT / 'data' / (name + '.pid.json')).write_text(json.dumps({'pid': child.pid, 'marker': marker}))
    deadline = time.monotonic() + 80
    while time.monotonic() < deadline:
        if reachable(url):
            return
        if child.poll() is not None:
            raise RuntimeError(name + ' exited. See ' + str(ROOT / 'logs' / (name + '.log')))
        time.sleep(0.4)
    raise RuntimeError(name + ' did not become ready. See its log.')

def stop_process(name):
    data = process_alive(name)
    if data:
        os.killpg(data['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and process_alive(name):
            time.sleep(0.2)
        if process_alive(name):
            os.killpg(data['pid'], signal.SIGKILL)
    (ROOT / 'data' / (name + '.pid.json')).unlink(missing_ok=True)

def stop_ui():
    marker = '--user-data-dir=' + str(ROOT / 'data/elara-ui-profile')
    subprocess.run(['/usr/bin/pkill', '-f', '--', marker], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if subprocess.run(['/usr/bin/pgrep', '-x', 'Google Chrome'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        script = '''tell application "Google Chrome"
repeat with w in windows
repeat with i from (count tabs of w) to 1 by -1
set u to ""
try
set u to URL of tab i of w
end try
if u starts with "http://localhost:4100" or u starts with "http://127.0.0.1:4100" then close tab i of w
end repeat
end repeat
end tell'''
        subprocess.run(['/usr/bin/osascript', '-e', script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def start_voice():
    start_process('kokoro', [str(NODE), str(ROOT / 'runtime/kokoro/server.mjs')], str(ROOT / 'runtime/kokoro/server.mjs'), 'http://127.0.0.1:7863/health')
    required = ['runtime/whisper-server', 'models/ggml-small.bin']
    for file in required:
        if not (ROOT / file).is_file():
            raise RuntimeError('Installation is incomplete: ' + file)
    start_process('whisper', [str(ROOT / 'runtime/whisper-server'), '--host', '127.0.0.1', '--port', '8188', '--model', str(ROOT / 'models/ggml-small.bin'), '--language', 'auto', '--threads', '4'], str(ROOT / 'runtime/whisper-server'), 'http://127.0.0.1:8188/health')
    if read_config().get('speech_runtime') == 'audio-cpp':
        required = ['runtime/audiocpp_server', 'models/breeze-tts-2-q8_0.gguf', 'config/audio-cpp.json']
        for file in required:
            if not (ROOT / file).is_file():
                raise RuntimeError('Breeze is selected but missing: ' + file)
        start_process('speech', [str(ROOT / 'runtime/audiocpp_server'), '--config', str(ROOT / 'config/audio-cpp.json')], str(ROOT / 'runtime/audiocpp_server'), 'http://127.0.0.1:7862/health')

def portal_client():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def api(path, data=None, method=None):
        request = urllib.request.Request(PORTAL + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'}, method=method)
        with opener.open(request, timeout=120) as response:
            return json.load(response)
    return api

def initialize():
    api = portal_client()
    current = api('/api/voice')
    if not current.get('enabled'):
        cfg = read_config()
        api('/api/voice', {'enabled': True, 'whisperUrl': 'http://127.0.0.1:8188/inference', 'breezeUrl': 'http://127.0.0.1:7863/v1/audio/speech', 'runtime': 'kokoro', 'kokoroVoice': 'af_heart', 'speechRate': 1, 'voice': 'design', 'language': 'en', 'instruction': cfg['speech_instruction'], 'cfgScale': cfg['cfg_scale'], 'lazyLoad': True, 'vad': {'positiveSpeechThreshold': 0.45, 'negativeSpeechThreshold': 0.25, 'minSpeechMs': 128, 'preSpeechPadMs': 480, 'redemptionMs': 1000}}, method='PUT')
    browser = api('/api/browser')
    if not browser.get('running'):
        api('/api/browser/start', {})
    if not browser.get('connectedAs'):
        api('/api/browser/connect', {})

def ensure_model():
    if read_config().get('provider') == 'omlx':
        if not reachable('http://127.0.0.1:8000/health'):
            subprocess.run(['/usr/bin/open', '-a', 'oMLX'], check=True)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and not reachable('http://127.0.0.1:8000/health'):
                time.sleep(0.5)
        key = json.loads((Path.home() / '.omlx/settings.json').read_text())['auth']['api_key']
        headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
        request = urllib.request.Request('http://127.0.0.1:8000/v1/models/status', headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            models = json.load(response)['models']
        selected = next((m for m in models if m['id'] == read_config()['model']), None)
        if selected is None:
            raise RuntimeError('The configured model is not registered in oMLX')
        if not selected['loaded']:
            request = urllib.request.Request('http://127.0.0.1:8000/v1/models/' + read_config()['model'] + '/load', data=b'{}', headers=headers, method='POST')
            with urllib.request.urlopen(request, timeout=180) as response:
                response.read()
        return
    if not reachable('http://127.0.0.1:1234/v1/models'):
        subprocess.run(['/usr/bin/open', '-a', 'LM Studio'], check=True)
        subprocess.run([str(LMS), 'server', 'start', '--port', '1234'], check=True, timeout=60)
    # The final tested model key is kept in the local config.
    cfg = read_config()
    with urllib.request.urlopen('http://127.0.0.1:1234/api/v0/models', timeout=5) as response:
        models = json.load(response)['data']
    if not any(m['id'] == cfg['model'] and m.get('state') == 'loaded' for m in models):
        subprocess.run([str(LMS), 'load', cfg.get('model_key', cfg['model']), '--context-length', str(cfg['context_length']), '--identifier', cfg['model'], '--ttl', '3600', '--yes'], check=True, timeout=180)

def start():
    print('Preparing the local model in oMLX…', flush=True)
    ensure_model()
    print('Starting local speech services…', flush=True)
    start_voice()
    print('Opening the assistant services…', flush=True)
    start_process('portal', [str(NODE), str(APP / 'server/dist/index.js')], str(APP / 'server/dist/index.js'), PORTAL + '/api/auth/status')
    initialize()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'open', 'stop', 'status', 'start-voice', 'stop-voice'])
    args = parser.parse_args()
    # Separate locks: portal initialization can call voice service actions.
    lockname = 'voice' if args.action.endswith('-voice') else 'assistant'
    with (ROOT / 'data' / (lockname + '.lock')).open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action in ('start', 'open'):
            start()
            print('Elara is ready at ' + PORTAL)
            if args.action == 'open':
                stop_ui()
                print('Open a conversation and click the microphone, or type in the chat box.')
                session_id = read_config().get('session_id')
                app_url = PORTAL + (('/s/' + session_id) if session_id else '/')
                subprocess.run(['/usr/bin/open', '-na', 'Google Chrome', '--args', '--app=' + app_url, '--user-data-dir=' + str(ROOT / 'data/elara-ui-profile'), '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'], check=True)
        elif args.action == 'start-voice':
            start_voice()
        elif args.action == 'stop-voice':
            stop_process('speech'); stop_process('whisper'); stop_process('kokoro')
        elif args.action == 'stop':
            stop_ui()
            if reachable(PORTAL + '/api/auth/status'):
                try: portal_client()('/api/browser/stop', {})
                except Exception: pass
            stop_process('portal'); stop_process('speech'); stop_process('whisper'); stop_process('kokoro')
            print('Elara stopped. Existing LM Studio/oMLX services and model files are preserved.')
        else:
            print(json.dumps({'portal': reachable(PORTAL + '/api/auth/status'), 'kokoro': reachable('http://127.0.0.1:7863/health'), 'breeze': reachable('http://127.0.0.1:7862/health'), 'whisper': reachable('http://127.0.0.1:8188/health'), 'model': read_config()['model']}, indent=2))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Elara: ' + str(error), file=sys.stderr)
        sys.exit(1)
