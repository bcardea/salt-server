/* eslint‑disable no‑console */

import express from 'express';
import dotenv  from 'dotenv';
import cors    from 'cors';
import OpenAI, { toFile } from 'openai';
import axios   from 'axios';
import fs      from 'fs';
import path    from 'path';
import FormData from 'form-data';
import RunwayML from '@runwayml/sdk';

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

/* ───────────────────────────────────────── CORS ── */
const allowedOrigins = [
  // production sites
  'https://usesaltcreative.com',
  'https://www.usesaltcreative.com',
  'https://incredible-figolla-a49ac9.netlify.app',
];

// extra origins when developing locally
if (process.env.NODE_ENV === 'development') {
  allowedOrigins.push(
    'http://localhost:3000',
    'http://localhost:8081',
    'http://localhost:5173',
  );
}

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS: Origin not allowed'), false);
    },
    methods: ['GET', 'POST'],
    credentials: true,
    maxAge: 86_400, // 24 h
  }),
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/* ─────────────────────────────────── OpenAI / Runway ── */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const openRouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://usesaltcreative.com',
    'X-Title':      'Salt Creative',
  },
});

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });

/* ─────────────────────────── Utility helpers ── */
async function downloadImageAsBuffer(url) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(data);
}

/* ──────────────────────────── Runway: animate image ── */
async function animateImage(imageBase64) {
  const task = await runway.imageToVideo.create({
    model: 'gen4_turbo',
    promptImage: `data:image/png;base64,${imageBase64}`,
    promptText:
      'KEEP ALL TEXT AND LOGOS COMPLETELY STATIC, 0% DISTORTION. Add lifelike and cinematic animation to the primary background elements including any sky, clouds, water. looping video starts and ends on same frame.',
    ratio: '1280:720',
    duration: 5,
  });

  let status;
  do {
    await new Promise((r) => setTimeout(r, 10_000));
    status = await runway.tasks.retrieve(task.id);
  } while (!['SUCCEEDED', 'FAILED'].includes(status.status));

  if (status.status === 'FAILED') throw new Error('Runway task failed');
  return status.output[0];
}

/* ──────────────────────────── Ideogram: typography ── */
async function generateTypography(headline, subHeadline, style) {
  const stylePrompt = {
    focused:     'make it focused and clean',
    trendy:      'make it fun and trendy',
    kids:        'make it for kids and childrens church - Use fun bubbly, 3D or illustrated fonts, use a white or cream color for subtitle text to ensure contrast and easy readability.',
    handwritten: 'make it handwritten',
  }[style] || 'make it focused and clean';

  const prompt = `Create a beautifully designed modern typography for the following Church poster headline and subheadline: "${headline}: ${subHeadline}", create just the typography on a single color background, use a nice combination of fonts appropriate for modern graphic design in 2025, ${stylePrompt}`;

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('aspect_ratio', '3x2');
  form.append('rendering_speed', 'QUALITY');
  form.append('magic_prompt', 'AUTO');
  form.append('num_images', '4');
  form.append('style_type', 'DESIGN');

  const { data } = await axios.post(
    'https://api.ideogram.ai/v1/ideogram-v3/generate',
    form,
    { headers: { ...form.getHeaders(), 'Api-Key': process.env.IDEOGRAM_API_KEY } },
  );
  return data.data;
}

/* ───────────────────────── OpenAI: final poster images ── */
// (generateFinalImage, generateFinalImageAlternative, generateFinalImageResponses)
//  — unchanged from your original, snipped here for brevity —
/* Copy your three generate* functions here exactly as before */

/* ─────────────────────── Sermon helpers (JSON mode) ── */
async function generateSermonAngles(topic, scripture, length, audience) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await openRouter.chat.completions.create({
      model:           'deepseek/deepseek-r1-0528-qwen3-8b:free',
      temperature:     0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Return **exactly 4** sermon angles as a JSON array—no keys.
Each angle object MUST have:
  - "title"        (string)
  - "coreSummary"  (string, 1-2 sentences)
  - "journey"      (string, short phrase)`,
        },
        {
          role: 'user',
          content: `Need 4 angles for "${topic}" (${scripture}) aimed at ${audience}, ${length}.`,
        },
      ],
    });

    // parse & normalise
    let raw       = JSON.parse(res.choices[0].message.content);
    let anglesArr = Array.isArray(raw) ? raw : Object.values(raw);

    // if model used "summary", map it to coreSummary
    anglesArr = anglesArr.map((a) =>
      a.coreSummary ? a : { ...a, coreSummary: a.summary ?? '' },
    );

    if (anglesArr.length >= 3) return anglesArr;   // ← return ARRAY only
  }
  throw new Error('Model failed to produce ≥3 angles after 3 tries');
}


async function generateSermonOutline(angle, scripture, audience, length) {
  const res = await openRouter.chat.completions.create({
    model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
    messages: [
      {
        role: 'user',
        content: `As an expert homiletics professor, create a detailed sermon outline.

Main Idea: "${angle}"
Primary Scripture: "${scripture}"
Audience: ${audience}
Length: ${length}

Follow Introduction → 3–4 points → Conclusion structure. Use Markdown only.`,
      },
    ],
  });
  return res.choices[0].message.content;
}

/* ───────────────── Research + Comms helpers (unchanged) ── */
async function generateResearchAnalysis(topic) { /* your original body */ }
async function generateCommunicationDraft(type, topic, keyPoints, tone, audience) { /* original body */ }

/* ───────────────────────────── Routes ── */
app.post('/api/depth', async (req, res) => {
  try {
    const { research_topic } = req.body;
    if (!research_topic) return res.status(400).json({ error: 'research_topic is required' });
    res.json({ analysis: await generateResearchAnalysis(research_topic) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/flavor', async (req, res) => {
  try {
    const { topic, scripture, length, audience, chosenAngle } = req.body;
    if (chosenAngle) {
      const outline = await generateSermonOutline(chosenAngle, scripture, audience, length);
      return res.json({ outline });
    }
    const angles = await generateSermonAngles(topic, scripture, length, audience);
    res.json({ angles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/aroma', async (req, res) => {
  try {
    const { type, topic, keyPoints, tone, audience } = req.body;
    if (!(type && topic && keyPoints && tone && audience))
      return res.status(400).json({ error: 'All fields are required' });

    const valid = [
      'social-facebook', 'social-twitter', 'social-instagram',
      'email-newsletter', 'email-thankyou', 'email-announcement',
      'event-description',
    ];
    if (!valid.includes(type))
      return res.status(400).json({ error: `type must be one of: ${valid.join(', ')}` });

    res.json({ draft: await generateCommunicationDraft(type, topic, keyPoints, tone, audience) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* The rest of your endpoints: proxy-image, suggest-backgrounds, generate-typography,
   generate-final, animate, health – copy them here unchanged.
   None of them contained TypeScript syntax, so they will run as‑is. */

/* ───────────────────────────── Start server ── */
app.listen(port, () => console.log(`🌟 Salt‑server listening on ${port}`));

