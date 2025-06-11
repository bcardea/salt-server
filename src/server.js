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
import { z } from 'zod';

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
    maxAge: 86_400, // 24 h
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

/* ──── Runtime type validation with Zod ───── */
const Angle = z.object({
  title: z.string(),
  summary: z.string(),
  journey: z.string()
});

const AnglesResponse = z.object({
  angles: z.array(Angle).min(3).max(5)
});

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
// Generate final image with OpenAI Image Edit API
async function generateFinalImage(typographyUrl, imageDescription) {
  try {
    console.log('Typography URL:', typographyUrl);
    console.log('Image Description:', imageDescription);

    // Download the typography image from Ideogram
    const typographyBuffer = await downloadImageAsBuffer(typographyUrl);
  
    // Create a temporary file for the typography image
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  
    const tempFilePath = path.join(tempDir, `typography_${Date.now()}.png`);
    fs.writeFileSync(tempFilePath, typographyBuffer);

    // Use GPT-4o to enhance the image description into a final prompt
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a professional photographer and designer. Your task is to enhance image descriptions into detailed prompts for an AI image generator. The prompt should focus on creating a beautiful, well-lit photo that works as a poster backdrop with the typography overlaid. Make it filmic, with a light 35 mm grain pass for subtle texture."
        },
        {
          role: "user",
          content: `Create a detailed prompt for this scene: ${imageDescription}`
        }
      ]
    });

    const enhancedDescription = response.choices[0].message.content;
    const editPrompt = `
You are composing a 1536x1024 landscape poster.

➡️  BACKGROUND
• Generate a beautifully shot photo that matches this description: "${enhancedDescription}".
• Filmic lighting, gentle depth-of-field, and a light 35 mm grain pass for subtle texture.
• Keep the scene uncluttered so the center remains visually calm.

➡️  TYPOGRAPHY OVERLAY  – CRITICAL CENTERING INSTRUCTIONS
• Import the uploaded typography image EXACTLY as provided - preserve all fonts, colors, and styling.
• CENTERING METHOD: 
  - Calculate the exact center point of the 1536x1024 canvas (768px horizontal, 512px vertical)
  - Place the typography so its visual center aligns with this canvas center point
  - Scale the typography to approximately 40-50% of canvas height while maintaining aspect ratio
  - The typography must be PERFECTLY CENTERED both horizontally and vertically
• DO NOT crop or cut off any part of the typography
• Ensure the entire typography is visible within the frame

➡️  COMPOSITION RULES
• The typography layer must sit on top of the photo, fully opaque.
• No additional text or graphic embellishments.
• If needed, subtly darken the background area behind the text for contrast.
• The typography positioning is CRITICAL - it must be mathematically centered.

Export as a single flattened 1536x1024 image with the typography perfectly centered.`;

    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: await toFile(fs.createReadStream(tempFilePath), 'typography.png', {
        type: "image/png",
      }),
      prompt: editPrompt,
      size: "1536x1024"
    });

    fs.unlinkSync(tempFilePath);

    console.log('Edit API response:', JSON.stringify(result.data[0], null, 2));
  
    if (result.data[0].b64_json) {
      const base64Image = result.data[0].b64_json;
      const imageDataUrl = `data:image/png;base64,${base64Image}`;
      console.log('Successfully generated final image (base64)');
      return imageDataUrl;
    } else if (result.data[0].url) {
      const imageUrl = result.data[0].url;
      console.log('Successfully generated final image (URL)');
      return imageUrl;
    } else {
      console.error('Unexpected response format:', result.data[0]);
      throw new Error('Image data not found in response');
    }

  } catch (error) {
    console.error('OpenAI API error in generateFinalImage:');
    console.error('Full error:', error);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw new Error(`Failed to generate final image: ${error.message}`);
  }
}

// Alternative approach using Image Generation (not edit) with base64 response
async function generateFinalImageAlternative(typographyUrl, imageDescription) {
  try {
    console.log('Using alternative generation approach');
  
    const generationPrompt = `Create a church poster with modern typography overlaid on ${imageDescription}. The poster should have a professional, inspiring design suitable for a church event or service. The typography should be prominent and readable against the background.`;

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: generationPrompt,
      size: "1536x1024",
      quality: "high",
      response_format: "b64_json"
    });

    const base64Image = result.data[0].b64_json;
    const imageDataUrl = `data:image/png;base64,${base64Image}`;

    console.log('Successfully generated final image (alternative method)');
    return imageDataUrl;

  } catch (error) {
    console.error('OpenAI API error in alternative generation:', error);
    throw new Error(`Failed to generate final image: ${error.message}`);
  }
}

// Third approach: Using Responses API for image generation with input image
async function generateFinalImageResponses(typographyUrl, imageDescription) {
  try {
    console.log('Using Responses API approach');
  
    const typographyBuffer = await downloadImageAsBuffer(typographyUrl);
    const base64Typography = typographyBuffer.toString('base64');
  
    const prompt = `Using the typography from the provided image, create a church poster with the following scene: ${imageDescription}. The typography should be prominently featured and integrated naturally into the composition.`;

    const response = await openai.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${base64Typography}`,
            }
          ],
        }
      ],
      tools: [{ type: "image_generation", quality: "high", size: "1536x1024" }],
    });

    const imageData = response.output
      .filter((output) => output.type === "image_generation_call")
      .map((output) => output.result);

    if (imageData.length > 0) {
      const imageBase64 = imageData[0];
      const imageDataUrl = `data:image/png;base64,${imageBase64}`;
      console.log('Successfully generated final image (Responses API)');
      return imageDataUrl;
    } else {
      throw new Error('No image generated in response');
    }

  } catch (error) {
    console.error('OpenAI Responses API error:', error);
    throw new Error(`Failed to generate final image: ${error.message}`);
  }
}

/* ─────────────────────── Sermon helpers (JSON mode) ── */
async function callForAngles(prompt) {
  const completion = await openRouter.chat.completions.create({
    model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
    messages: [
      {
        role: 'system',
        content: 'Return valid JSON only. Shape: { angles: Angle[] (3-5) }.'
      },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' } // JSON-mode!
  });

  return JSON.parse(completion.choices[0].message.content);
}

async function generateSermonOutline(
  topic,
  scripture,
  length,
  audience,
  chosenAngleTitle, // ← now a string, not an object
) {
  const res = await openRouter.chat.completions.create({
    model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
    temperature: 0.15,
    messages: [
      {
        role: 'system',
        content: `You are a sermon-outline assistant. 
Return your answer in **Markdown**, US English only, no other alphabets.`,
      },
      {
        role: 'user',
        content: `
Create a detailed outline on **"${chosenAngleTitle}"**  
Topic: ${topic} — ${scripture} — ${length} — Audience: ${audience}.`,
      },
    ],
  });

  // Optional Cyrillic scrub
  let outline = res.choices[0].message.content;
  outline = outline.replace(/\p{Script=Cyrillic}/gu, '');

  return outline;
}

/* ───────────────── Research + Comms helpers (unchanged) ── */
async function generateResearchAnalysis(topic) {
  try {
    const prompt = `
Provide a comprehensive research analysis on the topic: "${topic}".
Structure your response with the following sections:
1.  **Overview**: A brief introduction to the topic.
2.  **Key Sub-topics/Themes**: Identify and elaborate on 3-5 major sub-topics or themes related to the main topic.
3.  **Illustrative Examples or Case Studies**: Provide 1-2 relevant examples or case studies that help illustrate the concepts.
4.  **Potential Resources for Further Reading**: Suggest 2-3 credible sources (articles, books, websites) for deeper exploration.
5.  **Smart Summary/Key Takeaways**: Conclude with a concise summary of the most important points.

Format your output clearly using Markdown.
`;
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        { role: 'system', content: 'You are a helpful research assistant. Provide detailed and structured analysis.' },
        { role: 'user', content: prompt }
      ],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error in generateResearchAnalysis:', error);
    throw new Error(`Failed to generate research analysis: ${error.message}`);
  }
}
async function generateCommunicationDraft(type, topic, keyPoints, tone, audience) {
  try {
    const keyPointsString = Array.isArray(keyPoints) ? keyPoints.join(', ') : keyPoints;
    const prompt = `
Generate a communication draft for the following requirements:

Communication Type: ${type}
Topic: "${topic}"
Key Points to Cover: ${keyPointsString}
Desired Tone: ${tone}
Target Audience: ${audience}

Please craft the content tailored to these specifications. Ensure the output is ready to be used for the specified communication type.
Use Markdown for formatting if appropriate for the type (e.g., for emails or event descriptions). For social media posts, keep it concise.
`;
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        { role: 'system', content: 'You are an expert communications assistant. Generate tailored content based on the provided specifications.' },
        { role: 'user', content: prompt }
      ],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error in generateCommunicationDraft:', error);
    throw new Error(`Failed to generate communication draft: ${error.message}`);
  }
}

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

    // ────── A) Generate ANGLES ──────
    if (!chosenAngle) {
      let attempts = 0;
      let parsed = null;

      const basePrompt = `
Topic: "${topic}"
Scripture: "${scripture}"
Length: ${length}, Audience: ${audience}.
Generate exactly FIVE sermon angles (title, summary, journey) as JSON.
`;

      while (attempts < 3 && !parsed) {
        attempts++;
        const raw = await callForAngles(basePrompt);
        try {
          parsed = AnglesResponse.parse(raw);     // zod validation
        } catch {
          // model mis-behaved; loop again
        }
      }

      if (!parsed) {
        return res
          .status(500)
          .json({ error: 'Model failed to produce ≥3 angles after 3 tries' });
      }

      // Success!  Trim to 3-5 (already validated); send to client
      return res.json({ angles: parsed.angles });
    }

    // ────── B) Outline branch ──────
    // `chosenAngle` is now expected to be a string (the title) from the client
    const outline = await generateSermonOutline(topic, scripture, length, audience, chosenAngle);
    return res.json({ outline });
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

// Proxy image endpoint
app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) {
      return res.status(400).send('No URL provided');
    }

    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    res.set('Content-Type', response.headers['content-type']);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    response.data.pipe(res);
  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(500).send('Error fetching image');
  }
});

// Background suggestion endpoint
app.post('/api/suggest-backgrounds', async (req, res) => {
  try {
    const { headline, subHeadline } = req.body;
    if (!headline || !subHeadline) {
      return res.status(400).json({ error: 'Missing headline or sub-headline' });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-nano-2025-04-14",
      messages: [
        {
          role: "system",
          content: "Generate exactly 5 background image concepts for a church poster. Return ONLY a JSON array of 5 short, descriptive strings (1-2 sentences each). Make them varied and visually compelling."
        },
        {
          role: "user",
          content: `Headline: "${headline}"\nSubheadline: "${subHeadline}"`
        }
      ],
      temperature: 0.8,
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    const suggestions = result.suggestions || result.ideas || result.background_concepts || (Array.isArray(result) ? result : Object.values(result)[0]);

    res.json({ suggestions });
  } catch (error) {
    console.error('Error generating background suggestions:', error);
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

app.post('/api/generate-typography', async (req, res) => {
  try {
    const { headline, subHeadline, style } = req.body;
    if (!headline || !subHeadline || !style) {
      return res.status(400).json({ error: 'Missing headline, sub-headline, or style' });
    }
    const images = await generateTypography(headline, subHeadline, style);
    res.json({ images });
  } catch (error) {
    console.error('Error in /api/generate-typography:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate-final', async (req, res) => {
  try {
    const { typographyUrl, imageDescription, method = 'edit' } = req.body;
    if (!typographyUrl || !imageDescription) {
      return res.status(400).json({ error: 'Missing typography URL or image description' });
    }

    let finalImage;
    switch(method) {
      case 'edit':
        finalImage = await generateFinalImage(typographyUrl, imageDescription);
        break;
      case 'generate':
        finalImage = await generateFinalImageAlternative(typographyUrl, imageDescription);
        break;
      case 'responses':
        finalImage = await generateFinalImageResponses(typographyUrl, imageDescription);
        break;
      default:
        finalImage = await generateFinalImage(typographyUrl, imageDescription);
    }
    res.json({ imageUrl: finalImage });
  } catch (error) {
    console.error('Error in /api/generate-final:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint to animate an image
app.post('/api/animate', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing image data' });
    }
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const videoUrl = await animateImage(cleanBase64);
    res.json({ videoUrl });
  } catch (error) {
    console.error('Error in /api/animate:', error);
    res.status(500).json({ error: error.message });
  }
});

/* ───────────────────────────── Start server ── */
app.listen(port, () => console.log(`🌟 Salt‑server listening on ${port}`));
