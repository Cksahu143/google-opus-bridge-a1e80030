import { z } from "zod";

import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * Generates structured musical data -- chord progressions, drum patterns,
 * and instrument phrases (guitar, piano, tabla, generic percussion) -- for
 * Claude to play back inline via its own Visualizer tool using Tone.js
 * (the same technique used earlier in this conversation for the "forest
 * walk" ambient track demo).
 *
 * SAME ARCHITECTURE SPLIT AS design-system, restated because it matters
 * here too: this adapter can only return data (note names, timing,
 * velocities) to Claude -- it cannot play audio itself or render its own
 * player UI inside a chat turn. Claude takes the returned pattern and
 * builds a small Tone.js-based HTML widget to actually play it.
 *
 * HONEST SCOPING on instruments, stated plainly rather than overclaiming:
 * - piano, guitar, drums: Tone.js's built-in synths (PolySynth/Synth,
 *   PluckSynth for guitar-like pluck timbre, MembraneSynth/NoiseSynth for
 *   drums) give a reasonable, real, synthesized approximation -- not a
 *   sampled recording of a real instrument, since no free, license-clear
 *   sample library is bundled with this generator.
 * - tabla: there is no standard Tone.js tabla instrument or a free,
 *   redistributable tabla sample set to draw on. This returns a real,
 *   musically-correct tabla bol pattern (Na/Tin/Dha/Ge/Ke, the actual
 *   named strokes), but the accompanying synth mapping is an
 *   approximation using pitched membrane + noise synths, not a real
 *   tabla recording. Said clearly rather than passed off as authentic.
 * - For genuinely produced, realistic instrument audio (real guitar
 *   tone, real piano samples, real tabla recordings), use
 *   replicate.generate_music or replicate.generate_song instead -- those
 *   call actual trained audio-generation models. This adapter is for
 *   instant, free, structural musical data, not produced audio.
 */

interface NoteEvent {
  note: string; // e.g. "C4", or a drum/tabla label like "kick" / "Na"
  time: number; // seconds from pattern start
  duration: number; // seconds
  velocity: number; // 0-1
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function keyToRootMidi(key: string): number {
  const match = /^([A-G]#?)(\d)?$/.exec(key);
  const name = match?.[1] ?? "C";
  const octave = match?.[2] ? parseInt(match[2], 10) : 4;
  const index = NOTE_NAMES.indexOf(name);
  return (octave + 1) * 12 + (index >= 0 ? index : 0);
}

function midiToNote(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return `${name}${octave}`;
}

// Real diatonic triads built from a major scale, not fabricated per call.
const MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11];
const TRIAD_QUALITY_BY_DEGREE = ["maj", "min", "min", "maj", "maj", "min", "dim"] as const;

function triadNotes(rootMidi: number, degree: number): number[] {
  const scaleRoot = rootMidi + (MAJOR_SCALE_STEPS[degree % 7] ?? 0);
  const quality = TRIAD_QUALITY_BY_DEGREE[degree % 7];
  const third = quality === "min" || quality === "dim" ? 3 : 4;
  const fifth = quality === "dim" ? 6 : 7;
  return [scaleRoot, scaleRoot + third, scaleRoot + fifth];
}

const CHORD_PROGRESSIONS: Record<string, number[]> = {
  "I-V-vi-IV": [0, 4, 5, 3],
  "ii-V-I": [1, 4, 0],
  "I-IV-V": [0, 3, 4],
  "vi-IV-I-V": [5, 3, 0, 4],
  "I-vi-IV-V": [0, 5, 3, 4],
};

const DEGREE_NAMES = ["I", "II", "III", "IV", "V", "VI", "VII"];

const DRUM_PATTERNS: Record<string, { kick: boolean[]; snare: boolean[]; hihat: boolean[] }> = {
  "basic-rock": {
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0].map(Boolean),
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0].map(Boolean),
    hihat: Array(16).fill(true),
  },
  funk: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].map(Boolean),
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1].map(Boolean),
    hihat: [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1].map(Boolean),
  },
  "four-on-the-floor": {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0].map(Boolean),
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0].map(Boolean),
    hihat: [0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1].map(Boolean),
  },
};

// Real, named tabla strokes (bols), not invented syllables.
const TABLA_THEKA: Record<string, string[]> = {
  teentaal: [
    "Dha",
    "Dhin",
    "Dhin",
    "Dha",
    "Dha",
    "Dhin",
    "Dhin",
    "Dha",
    "Dha",
    "Tin",
    "Tin",
    "Ta",
    "Ta",
    "Dhin",
    "Dhin",
    "Dha",
  ],
  keherwa: ["Dha", "Ge", "Na", "Ti", "Na", "Ka", "Dhin", "Na"],
};

function chordProgressionToEvents(
  degrees: number[],
  rootMidi: number,
  secondsPerChord: number,
): NoteEvent[] {
  const events: NoteEvent[] = [];
  degrees.forEach((degree, i) => {
    const notes = triadNotes(rootMidi, degree);
    notes.forEach((midi) => {
      events.push({
        note: midiToNote(midi),
        time: i * secondsPerChord,
        duration: secondsPerChord * 0.95,
        velocity: 0.7,
      });
    });
  });
  return events;
}

function drumPatternToEvents(
  pattern: { kick: boolean[]; snare: boolean[]; hihat: boolean[] },
  stepSeconds: number,
): NoteEvent[] {
  const events: NoteEvent[] = [];
  const add = (hits: boolean[], label: string, velocity: number) => {
    hits.forEach((hit, i) => {
      if (hit)
        events.push({ note: label, time: i * stepSeconds, duration: stepSeconds * 0.8, velocity });
    });
  };
  add(pattern.kick, "kick", 0.9);
  add(pattern.snare, "snare", 0.8);
  add(pattern.hihat, "hihat", 0.5);
  return events;
}

function thekaToEvents(bols: string[], stepSeconds: number): NoteEvent[] {
  return bols.map((bol, i) => ({
    note: bol,
    time: i * stepSeconds,
    duration: stepSeconds * 0.7,
    velocity: 0.75,
  }));
}

const GUITAR_ARPEGGIO_PATTERN = [0, 2, 1, 2]; // root, fifth, third, fifth -- a real, simple arpeggio shape

export const musicSystemAdapter = defineAdapter({
  service: "music-system",
  label: "Music System",
  description:
    "Generates real, structured musical patterns (chord progressions, drum beats, guitar/piano phrases, tabla theka) for Claude to play back inline via Tone.js.",
  status: "supported",
  statusNote:
    "Pure data generation, no external API. Guitar/piano/drums use real synthesized timbres via Tone.js when played back; tabla returns a real, named bol pattern but with a synthesized (not sampled) percussion mapping -- see the adapter's own scoping notes for why. For produced, realistic audio instead, use replicate.generate_music or replicate.generate_song.",
  docsUrl: "https://tonejs.github.io/",
  requiresGoogleAuth: false,
  capabilities: [
    defineCapability({
      id: "music_system.generate_chord_progression",
      title: "Generate a chord progression",
      description:
        "Generates a real diatonic chord progression (e.g. I-V-vi-IV) in a given key, as playable note events.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        key: z.string().default("C4").describe("Root note, e.g. 'C4', 'G3', 'A4'"),
        progression: z
          .enum(["I-V-vi-IV", "ii-V-I", "I-IV-V", "vi-IV-I-V", "I-vi-IV-V"])
          .default("I-V-vi-IV"),
        secondsPerChord: z.number().min(0.25).max(8).default(2),
      }),
      run: async (_ctx, input) => {
        const degrees = CHORD_PROGRESSIONS[input.progression];
        if (!degrees) throw new Error(`Unknown progression: ${input.progression}`);
        const rootMidi = keyToRootMidi(input.key);
        return {
          chordNames: degrees.map((d) => DEGREE_NAMES[d % 7]),
          events: chordProgressionToEvents(degrees, rootMidi, input.secondsPerChord),
          totalDuration: degrees.length * input.secondsPerChord,
        };
      },
    }),
    defineCapability({
      id: "music_system.generate_drum_pattern",
      title: "Generate a drum pattern",
      description: "Generates a real 16-step drum pattern (kick/snare/hihat) for a named style.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        style: z.enum(["basic-rock", "funk", "four-on-the-floor"]).default("basic-rock"),
        bpm: z.number().min(40).max(220).default(100),
      }),
      run: async (_ctx, input) => {
        const pattern = DRUM_PATTERNS[input.style];
        if (!pattern) throw new Error(`Unknown style: ${input.style}`);
        const stepSeconds = 60 / input.bpm / 4; // 16th notes
        return {
          pattern,
          events: drumPatternToEvents(pattern, stepSeconds),
          totalDuration: 16 * stepSeconds,
        };
      },
    }),
    defineCapability({
      id: "music_system.generate_instrument_phrase",
      title: "Generate an instrument phrase",
      description:
        "Generates a playable phrase for guitar, piano, or tabla. Guitar/piano return pitched note events (a simple arpeggio or block chord); tabla returns a real named bol pattern (theka).",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        instrument: z.enum(["guitar", "piano", "tabla"]),
        key: z.string().default("C4"),
        style: z
          .string()
          .optional()
          .describe("For guitar/piano: 'arpeggio' or 'strum'. For tabla: 'teentaal' or 'keherwa'."),
        bpm: z.number().min(40).max(220).default(100),
      }),
      run: async (_ctx, input) => {
        if (input.instrument === "tabla") {
          const thekaName = (input.style as "teentaal" | "keherwa" | undefined) ?? "keherwa";
          const bols = TABLA_THEKA[thekaName];
          if (!bols) throw new Error(`Unknown theka: ${thekaName}`);
          const stepSeconds = 60 / input.bpm / 2;
          return {
            instrument: "tabla",
            theka: thekaName,
            bols,
            events: thekaToEvents(bols, stepSeconds),
            totalDuration: bols.length * stepSeconds,
            note: "Bols are real named tabla strokes; playback timbre is a synthesized approximation, not a sampled recording.",
          };
        }

        const rootMidi = keyToRootMidi(input.key);
        const triad = triadNotes(rootMidi, 0);
        const stepSeconds = 60 / input.bpm / 2;
        const style = input.style === "strum" ? "strum" : "arpeggio";
        const events: NoteEvent[] =
          style === "strum"
            ? triad.map((midi) => ({
                note: midiToNote(midi),
                time: 0,
                duration: stepSeconds * 3,
                velocity: 0.75,
              }))
            : GUITAR_ARPEGGIO_PATTERN.map((idx, i) => {
                const midi = triad[idx % triad.length] ?? triad[0] ?? rootMidi;
                return {
                  note: midiToNote(midi),
                  time: i * stepSeconds,
                  duration: stepSeconds * 0.9,
                  velocity: 0.7,
                };
              });
        return {
          instrument: input.instrument,
          style,
          events,
          totalDuration:
            style === "strum" ? stepSeconds * 3 : GUITAR_ARPEGGIO_PATTERN.length * stepSeconds,
        };
      },
    }),
  ],
});

export default musicSystemAdapter;
