import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/browser', route => route.fulfill({ json: { running: false, sessions: [], install: { container: 'stopped' } } }));
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
  await page.addInitScript(() => {
    (window as any).testAudioInputs = [{ kind: 'audioinput', deviceId: 'macbook', label: 'MacBook microphone' }, { kind: 'audioinput', deviceId: 'insta360', label: 'Insta360 microphone' }];
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => (window as any).testAudioInputs });
  });
  await page.goto('/tests/voice.html');
});

test('selects and remembers a specific microphone and detects its speech', async ({ page }) => {
  const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'Audio from the selected microphone.' } }));
  await page.route('**/voice/speech', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('insta360');
  await page.reload();
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await expect(page.getByLabel('Audio input', { exact: true })).toHaveValue('insta360');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  expect(await page.evaluate(() => (window as any).microphoneTest.requests.at(-1).audio.deviceId)).toEqual({ exact: 'insta360' });
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await expect(page.getByText('Using Insta360 microphone', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
});

test('switches active microphones, releases the old track, and preserves mute', async ({ page }) => {
  const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'Speech after switching inputs.' } }));
  await page.route('**/voice/speech', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('insta360');
  await expect(page.getByText('Using Insta360 microphone', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).microphoneTest.streams.map((s: MediaStream) => s.getTracks()[0].readyState))).toEqual(['ended', 'live']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('macbook');
  await expect(page.getByText('Using MacBook microphone', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Microphone muted');
  expect(await page.evaluate(() => (window as any).microphoneTest.streams.map((s: MediaStream) => ({ state: s.getTracks()[0].readyState, enabled: s.getTracks()[0].enabled })))).toEqual([{ state: 'ended', enabled: true }, { state: 'ended', enabled: false }, { state: 'live', enabled: false }]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('live:true');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
  expect(await page.evaluate(() => (window as any).microphoneTest.streams.every((s: MediaStream) => s.getTracks()[0].readyState === 'ended'))).toBe(true);
});

test('a failed device switch keeps the working microphone and saved selection', async ({ page }) => {
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.evaluate(() => { (window as any).microphoneTest.failDevice = 'insta360'; });
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('insta360');
  await expect(page.getByRole('alert')).toContainText('That microphone is unavailable');
  await expect(page.getByLabel('Audio input', { exact: true })).toHaveValue('');
  await expect(page.getByText('Using MacBook microphone', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).microphoneTest.streams[0].getTracks()[0].readyState)).toBe('live');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'End voice mode' }).click();
});

test('ending during a device switch releases the late microphone', async ({ page }) => {
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.evaluate(() => { (window as any).microphoneTest.delayDevice = 'insta360'; });
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('insta360');
  await expect(page.getByLabel('Audio input', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await page.evaluate(() => (window as any).microphoneTest.release());
  await expect.poll(() => page.evaluate(() => (window as any).microphoneTest.streams.map((s: MediaStream) => s.getTracks()[0].readyState))).toEqual(['ended', 'ended']);
  await expect(page.getByRole('button', { name: 'End voice mode' })).toHaveCount(0);
});

test('device changes update the list and the picker fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Choose audio input' }).click();
  await page.getByLabel('Audio input', { exact: true }).selectOption('insta360');
  await page.evaluate(() => {
    (window as any).testAudioInputs = [{ kind: 'audioinput', deviceId: 'macbook', label: 'MacBook microphone' }];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.getByRole('option', { name: 'Insta360 microphone (unavailable)' })).toHaveCount(1);
  const box = await page.getByRole('group', { name: 'Microphone settings' }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: '/tmp/elara-audio-input-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Microphone settings' })).toHaveCount(0);
});
