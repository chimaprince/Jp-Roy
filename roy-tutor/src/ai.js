import Anthropic from '@anthropic-ai/sdk';

// Server-side only. The API key is read from the environment by the SDK and is
// never sent to the browser.

const MODEL = process.env.TUTOR_MODEL || 'claude-opus-5';

const SOURCE_RULES = `You are part of a medical Mandarin tutor for a learner named Roy.
The curriculum is JH Medics Volume 1 and it is the source of truth.
- Never change, correct or reword the curriculum's English, Mandarin, pinyin or meaning. If an entry looks unusual, use it exactly as given.
- If the meaning is missing, do not invent one; say only what the English term and Mandarin give.
- Keep every exchange about the current term. Other medical vocabulary may only come from the "known terms" list; otherwise use only very basic everyday Mandarin.
- Replies are spoken aloud: keep them short, one or two sentences per line, no markdown.`;

function entryBlock(entry, known) {
  const knownList = known.length
    ? known.map((k) => `${k.english} = ${k.mandarin} (${k.pinyin})`).join('; ')
    : 'none yet';
  return `Current term (JH Medics Volume 1, entry ${entry.position}):
English: ${entry.english}
Mandarin: ${entry.mandarin}
Pinyin: ${entry.pinyin}
Meaning: ${entry.meaning ?? '(not supplied by the source)'}
Known terms Roy has already completed: ${knownList}`;
}

const LINE = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['en', 'zh'] },
    text: { type: 'string' },
  },
  required: ['lang', 'text'],
  additionalProperties: false,
};

const SENTENCE_SCHEMA = {
  type: 'object',
  properties: {
    correct: { type: 'boolean' },
    feedback: { type: 'array', items: LINE },
    corrected_sentence: { type: ['string', 'null'] },
  },
  required: ['correct', 'feedback', 'corrected_sentence'],
  additionalProperties: false,
};

const ROLEPLAY_SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: LINE },
    roy_used_term: { type: 'boolean' },
    finished: { type: 'boolean' },
  },
  required: ['lines', 'roy_used_term', 'finished'],
  additionalProperties: false,
};

export function createAi({ client } = {}) {
  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!client && !hasCredentials) return { enabled: false };
  const anthropic = client ?? new Anthropic();

  async function ask(system, messages, schema) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('model declined the request');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  return {
    enabled: true,

    async checkSentence({ entry, known, sentence }) {
      const system = `${SOURCE_RULES}

Roy was asked to use the current term in a sentence. Judge his sentence (it came from speech recognition, so ignore homophone slips and missing punctuation).
correct = true if it uses the Mandarin term sensibly. Give brief spoken feedback lines (English for explanation, zh for Mandarin). If there are mistakes, put one natural corrected sentence that uses the term in corrected_sentence, otherwise null.`;
      return ask(system, [{ role: 'user', content: `${entryBlock(entry, known)}\n\nRoy's sentence: ${sentence}` }], SENTENCE_SCHEMA);
    },

    async rolePlay({ entry, known, role, roySide, history, royText }) {
      const system = `${SOURCE_RULES}

Run a short medical interpreting role-play that practises the current term.
Roy is playing: ${roySide}. You play the other people in the scene (for example ${role === roySide ? 'the patient and doctor' : role}).
Rules:
- Each of your turns is one or two short lines. Mark English lines lang "en" and Mandarin lines lang "zh".
- Build the scene around the current term so Roy has to say it in Mandarin.
- If Roy made a mistake, correct it in one short English line first, giving the right Mandarin.
- Set roy_used_term true only if Roy's latest reply contains the Mandarin term.
- Set finished true after Roy has replied twice, and end with one short line of feedback.`;
      // `history` alternates user/assistant turns from earlier calls; the first
      // user turn always carries the term details.
      const userTurn = history.length ? royText : `${entryBlock(entry, known)}\n\nStart the scene now.`;
      const result = await ask(system, [...history, { role: 'user', content: userTurn }], ROLEPLAY_SCHEMA);
      const newHistory = [...history, { role: 'user', content: userTurn }, { role: 'assistant', content: JSON.stringify(result) }];
      return { ...result, history: newHistory };
    },
  };
}
