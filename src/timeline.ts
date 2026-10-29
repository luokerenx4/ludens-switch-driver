export type Span = { state: Record<string, number>; durationMs: number };
type Interval = { start: number; end: number; value: number };
type Boundary = { starts: [string, number][]; ends: string[] };

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Combine independently timed channels into the native bridge's complete-state spans. */
export function compileTimeline(inputs: unknown, buttons: readonly string[], axes: readonly string[], minSpanMs = 16): Span[] {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("inputs must be a non-empty array");
  if (!Number.isSafeInteger(minSpanMs) || minSpanMs < 1) throw new Error("minSpanMs must be a positive safe integer");
  const buttonSet = new Set(buttons);
  const axisSet = new Set(axes);
  const channels = [...buttons, ...axes];
  const intervals = new Map<string, Interval[]>();
  const boundaries = new Map<number, Boundary>();
  const boundary = (time: number) => {
    let value = boundaries.get(time);
    if (!value) boundaries.set(time, value = { starts: [], ends: [] });
    return value;
  };
  boundary(0);

  for (const [index, value] of inputs.entries()) {
    const input = object(value, `inputs[${index}]`);
    if (Object.keys(input).some(key => !["atMs", "durationMs", "state"].includes(key))) {
      throw new Error(`inputs[${index}] has an unknown field`);
    }
    const start = input.atMs as number;
    const duration = input.durationMs as number;
    if (!Number.isSafeInteger(start) || start < 0) throw new Error("atMs must be a non-negative safe integer");
    if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("durationMs must be a positive safe integer");
    const end = start + duration;
    if (!Number.isSafeInteger(end)) throw new Error("atMs + durationMs must be a safe integer");
    const state = object(input.state, `inputs[${index}].state`);
    const begin = boundary(start);
    const finish = boundary(end);
    for (const [channel, value] of Object.entries(state)) {
      if (!(buttonSet.has(channel) && (value === 0 || value === 1))
        && !(axisSet.has(channel) && typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1)) {
        throw new Error(`Invalid channel/value: ${channel}=${String(value)}`);
      }
      const spans = intervals.get(channel) ?? [];
      spans.push({ start, end, value: value as number });
      intervals.set(channel, spans);
      begin.starts.push([channel, value as number]);
      finish.ends.push(channel);
    }
  }

  for (const [channel, spans] of intervals) {
    spans.sort((a, b) => a.start - b.start);
    for (let index = 1; index < spans.length; index++) {
      if (spans[index].start < spans[index - 1].end) throw new Error(`Overlapping inputs for channel ${channel}`);
    }
  }

  const times = [...boundaries.keys()].sort((a, b) => a - b);
  const state: Record<string, number> = Object.fromEntries(channels.map(channel => [channel, 0]));
  const result: Span[] = [];
  for (let index = 0; index < times.length - 1; index++) {
    const event = boundaries.get(times[index])!;
    // A segment ending as the next starts must not insert a neutral sample.
    for (const channel of event.ends) state[channel] = 0;
    for (const [channel, value] of event.starts) state[channel] = value;
    const durationMs = times[index + 1] - times[index];
    const previous = result.at(-1);
    if (previous && channels.every(channel => previous.state[channel] === state[channel])) previous.durationMs += durationMs;
    else result.push({ state: { ...state }, durationMs });
  }
  if (result.some(span => span.durationMs < minSpanMs)) {
    throw new Error(`Timeline state changes must be at least ${minSpanMs} ms apart (including the initial gap and final span)`);
  }
  return result;
}
