import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { LuAudioLines } from 'react-icons/lu';

export type AudioInput = { deviceId: string; label: string };

export function AudioInputPicker({ devices, selected, activeLabel, busy, error, levels, onSelect, onRefresh }: {
  devices: AudioInput[];
  selected: AudioInput;
  activeLabel: string;
  busy: boolean;
  error: string;
  levels?: MutableRefObject<{ input: number; output: number }>;
  onSelect: (input: AudioInput) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const meter = useRef<HTMLMeterElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!button.current || !menu.current) return;
      const anchor = button.current.getBoundingClientRect();
      const box = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(16, Math.min(anchor.right - box.width, innerWidth - box.width - 16)), top: Math.max(16, Math.min(anchor.top - box.height - 10, innerHeight - box.height - 16)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, devices, activeLabel, busy, error]);
  useEffect(() => {
    if (!open) return;
    select.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    const timer = setInterval(() => { if (meter.current) meter.current.value = levels?.current.input ?? 0; }, 80);
    return () => { document.removeEventListener('pointerdown', outside); clearInterval(timer); };
  }, [open, levels]);
  const missing = selected.deviceId && !devices.some(device => device.deviceId === selected.deviceId);
  return <div ref={root} className="audio-input-picker" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); button.current?.focus(); }
  }}>
    <button ref={button} type="button" className="prompt-action" aria-label="Choose audio input" title={`Audio input: ${activeLabel || selected.label}`} aria-expanded={open} aria-controls={id}
      onClick={() => { setOpen(value => !value); }}><LuAudioLines aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} id={id} style={position} className="audio-input-menu" role="group" aria-label="Microphone settings">
      <label htmlFor={`${id}-select`}>Audio input</label>
      <select ref={select} id={`${id}-select`} value={selected.deviceId} disabled={busy}
        onChange={event => onSelect(devices.find(device => device.deviceId === event.target.value) ?? { deviceId: '', label: 'Browser default' })}>
        <option value="">Browser default</option>
        {missing && <option value={selected.deviceId}>{selected.label} (unavailable)</option>}
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
      </select>
      {activeLabel && <p>Using {activeLabel}</p>}
      {levels && <label className="audio-input-level">Input level<meter ref={meter} aria-label="Microphone input level" min={0} max={1} value={0} /></label>}
      {!devices.some(device => device.label) && <p>Allow microphone access to see device names.</p>}
      <button type="button" className="audio-input-refresh" disabled={busy} onClick={onRefresh}>{busy ? 'Connecting…' : 'Refresh microphones'}</button>
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
