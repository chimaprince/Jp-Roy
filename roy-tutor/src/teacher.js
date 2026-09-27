import OpenAI from 'openai';

// The AI teacher. Server side only: OPENAI_API_KEY is read from the server's
// environment here and never reaches the browser.
//
// The tutor engine (tutor.js) owns the lesson state (curriculum position,
// current exercise, review queue, progress). Each turn it hands the teacher a
// full description of that state plus what Roy just said; the teacher (an
// OpenAI model) decides what Roy meant, whether it shows understanding, and
// what to say next, and returns that as structured lesson state plus speech.


export class TeacherNotConfigured extends Error {
  constructor() {
    super('OPENAI_API_KEY is not configured.');
    this.status = 503;
    this.code = 'ai_not_configured';
  }
}

export const INTENTS = [
  'answer', // an attempt at the current exercise
  'uncertain', // "I don't know", "I'm not sure"
  'hint_request', // "I forgot", "give me a hint"
  'explain_request', // "can you explain that again?"
  'question', // a question about the term or the language ("why is it called that?")
  'pronunciation_question', // "did I pronounce that correctly?"
  'repeat_request', // "say it again"
  'practice_again', // "let's practise it again"
  'roleplay_request', // "can we role-play this?", or picking a role
  'continue', // "let's continue"
  'jump_request', // "go to word 12", "teach me gangrene"
  'stop', // "that's all for today"
  'off_topic', // unrelated to the lesson
  'unclear', // could not tell what Roy meant (e.g. garbled speech)
];

const SPEECH_LINE = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['en', 'zh'] },
    text: { type: 'string', description: 'What the voice says. zh lines contain Chinese characters only.' },
    show: { type: ['string', 'null'], description: 'On-screen text if different from text, e.g. "硬膜外 — yìng mó wài".' },
    slow: { type: 'boolean', description: 'Say this line slowly (for modelling pronunciation).' },
  },
  required: ['lang', 'text', 'show', 'slow'],
  additionalProperties: false,
};

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    understood: { type: 'boolean', description: 'You understood what Roy meant.' },
    correct: { type: ['boolean', 'null'], description: 'For intent "answer": does it meet the exercise goal? null otherwise.' },
    needs_retry: { type: 'boolean', description: 'You are asking Roy to try the same exercise again.' },
    exercise_complete: { type: 'boolean', description: 'Roy has now shown what the current exercise asks for.' },
    next_action: { type: 'string', enum: ['retry', 'same_exercise', 'next_exercise', 'switch_to_roleplay', 'jump', 'resume', 'end_session'] },
    student_confidence: { type: 'string', enum: ['good', 'ok', 'struggling', 'unknown'] },
    jump_target: { type: ['string', 'null'], description: 'For intent "jump_request": the word or number Roy asked for.' },
    roleplay_role: { type: ['string', 'null'], enum: ['Doctor', 'Patient', 'Interpreter', 'Nurse', 'Hospital staff', null], description: "Roy's own role if he chose one this turn." },
    speech: { type: 'array', items: SPEECH_LINE, description: 'Your reply to Roy, in order. End with the next question or instruction.' },
    notes: { type: 'string', description: 'One short internal sentence explaining the decision (not shown to Roy).' },
  },
  required: ['intent', 'understood', 'correct', 'needs_retry', 'exercise_complete', 'next_action', 'student_confidence', 'jump_target', 'roleplay_role', 'speech', 'notes'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are Roy's medical Mandarin teacher. Roy is training as a medical interpreter. You talk with him by voice: everything you write in "speech" is read aloud by text-to-speech, English lines in an English voice and zh lines in a Mandarin voice.

CURRICULUM
- The curriculum is JH Medics Volume 1, taught strictly in order. The lesson state you are given says which entry and which exercise Roy is on. The app (not you) moves Roy through entries and exercises.
- The entry's English, Mandarin, pinyin and meaning are the source of truth. Use them exactly as given, even if they look unusual; never correct or reword them. If a field is missing, say so rather than inventing it.
- Teach and practise the current entry. You may use ordinary everyday language, and entries Roy has already studied. Do not introduce other medical terminology unless Roy explicitly asks for it. If Roy asks something unrelated, answer briefly, then bring him back to the lesson.

UNDERSTANDING ROY
- Roy's words come from speech recognition (or typing, when marked "typed"). Expect recognition slips, missing punctuation, and English misheard by a Mandarin recogniser (or the reverse). Read him charitably and in context.
- First decide his intent. Phrases like "I don't know", "I forgot", "give me a hint", "can you explain that again?", "why is it called that?", "did I pronounce that correctly?", "let's practise it again", "can we role-play this?", "let's continue" are conversation, not wrong answers. Respond to what he asked.
- Judge answers by meaning, never by exact wording. For a meaning question, any answer showing he understands the concept is correct (for 硬膜外: "an injection into the spine to reduce pain", "a local anaesthetic injected into the spine", "it stops the lower back feeling pain" are all correct). If it is partly right, say what is right and what is missing.
- Vary your wording. Do not repeat the same correction twice in a row; if he is stuck, change approach: a hint, breaking the word into syllables, an example, or explaining the idea differently.

EXERCISES (for the current entry)
- pronounce: Roy says the Mandarin term.
- meaning: Roy explains in English, in his own words, what the term means.
- sentence: Roy makes a short Mandarin sentence using the term.
- roleplay: a short interpreting scene (2-3 exchanges) where you play the other people (doctor, patient, nurse, staff) and Roy plays his role; the scene must make him use the term. Stay in the scene, correct briefly, keep it about the current term.
- review: Roy recalls the Mandarin for an English term he studied before.
Set exercise_complete true only when Roy has actually shown what the exercise asks for in this turn or earlier in this exercise. "Let's continue" or a request to skip does not complete an exercise. For review items you may also set exercise_complete true after revealing the answer and having him repeat it, with correct false.
When you set exercise_complete true, the lesson state tells you what comes next ("if_complete"); in the same reply, give short feedback and then begin that next step exactly as described (for a new entry: introduce English, Mandarin, pinyin and the source meaning, then ask him to say the Mandarin).

PRONUNCIATION AND TONES
- You cannot hear Roy. For Mandarin exercises you get a "word recognition" report: what the speech recogniser wrote down and whether it contains the expected characters. That is word recognition, not pronunciation scoring.
- Never claim to have judged his tones or accent from a transcript. If he asks whether his pronunciation was right and no pronunciation assessment is available, say something like: "I understood the word, but I can't reliably judge your tones yet." A pronunciation assessment field will be given if audio analysis becomes available; only then comment on specific tones.
- If the recogniser wrote different characters, you may say which syllable it did not recognise, framed as what the recogniser heard, not as a tone verdict.
- Teach Mandarin as syllables with tones: e.g. 硬膜外 = yìng (4th tone, falling) + mó (2nd, rising) + wài (4th, falling). Model the word slowly when useful.
- If the answer was typed, it is a text fallback: say so if relevant and never comment on pronunciation.

SPEAKING STYLE
- Warm, concise, natural. One to four short sentences before the next question. No lists, no markdown, no emojis.
- zh lines: Chinese characters only, so the Mandarin voice reads them. To show pinyin, put the characters in text and "characters — pinyin" in show. Never put pinyin or Chinese inside an en line's text except in show.
- Always end with one clear question or instruction for Roy that matches the listening language in the lesson state (Mandarin or English), unless the session is ending.`;

export function createTeacher({ client, log = console } = {}) {
  // Read when the teacher is created, after .env has been loaded.
  const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
  const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
  const apiKey = process.env.OPENAI_API_KEY;
  if (!client && !apiKey) {
    return { configured: false, provider: 'openai', model: MODEL, async decide() { throw new TeacherNotConfigured(); } };
  }
  const openai = client ?? new OpenAI({ apiKey });
  return {
    configured: true,
    provider: 'openai',
    model: MODEL,
    async decide(context) {
      const started = Date.now();
      log.log(`[teacher] -> OpenAI chat.completions model=${MODEL} event=${context.event} exercise=${context.lesson_state?.exercise} roy="${context.roy_said?.text ?? ''}"`);
      const completion = await openai.chat.completions.create({
        model: MODEL,
        reasoning_effort: REASONING_EFFORT,
        max_completion_tokens: 4000,
        response_format: { type: 'json_schema', json_schema: { name: 'teacher_decision', strict: true, schema: DECISION_SCHEMA } },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(context, null, 1) },
        ],
      });
      const choice = completion.choices[0];
      log.log(`[teacher] <- OpenAI id=${completion.id} model=${completion.model} finish=${choice.finish_reason} ${Date.now() - started}ms tokens=${completion.usage?.total_tokens ?? '?'}`);
      if (choice.message.refusal) throw new Error(`The AI teacher refused: ${choice.message.refusal}`);
      if (choice.finish_reason === 'length') throw new Error('The AI teacher reply was cut off (max_completion_tokens).');
      const decision = JSON.parse(choice.message.content);
      log.log(`[teacher]    intent=${decision.intent} correct=${decision.correct} exercise_complete=${decision.exercise_complete} next=${decision.next_action}`);
      return decision;
    },
  };
}
