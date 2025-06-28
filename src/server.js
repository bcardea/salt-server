/* eslint‑disable no‑console */

import express from 'express';
import dotenv  from 'dotenv';
import cors    from 'cors';
import OpenAI, { toFile } from 'openai';
import axios   from 'axios';
import fs      from 'fs';
import path    from 'path';
import FormData from 'form-data';

import Replicate from 'replicate';
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
  'https://6851d32411955d00085ca882--incredible-figolla-a49ac9.netlify.app',
  'https://68544903b30e310008605970--incredible-figolla-a49ac9.netlify.app',
  'https://68603b514d09d700083c9372--incredible-figolla-a49ac9.netlify.app',
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

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY,
});



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

/* ──────────────────────────── Replicate: animate image ── */
async function animateImage(imageBase64, prompt = 'Animate the background in a realistic way, keeping the text exactly the same.') {
  try {
    // 1. Create the prediction
    const prediction = await replicate.predictions.create({
      model: 'bytedance/seedance-1-pro',
      input: {
        image: `data:image/png;base64,${imageBase64}`,
        prompt,
        resolution: '1080p',
        duration: 5,
        camera_fixed: true,
      },
    });

    console.log(`Replicate prediction created: ${prediction.id}. Status page: ${prediction.urls.get}`);

    // 2. Wait for the prediction to finish
    const completedPrediction = await replicate.wait(prediction);

    // 3. Handle the result
    if (completedPrediction.status === 'succeeded') {
      console.log('Replicate prediction succeeded. Output:', completedPrediction.output);
      return completedPrediction.output;
    }

    if (completedPrediction.status === 'failed' || completedPrediction.status === 'canceled') {
      console.error('Replicate prediction failed:', completedPrediction.error);
      throw new Error(`Replicate prediction failed: ${completedPrediction.error}`);
    }

    throw new Error(`Replicate prediction ended with unexpected status: ${completedPrediction.status}`);
  } catch (error) {
    console.error('Replicate API error in animateImage:', error);
    throw new Error(`Replicate API Error: ${error.message}`);
  }
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
function cleanJsonString(str) {
  // It's common for models to wrap JSON in ```json ... ```, so we strip it.
  const match = str.match(/```json\n([\s\S]*?)\n```/);
  return match ? match[1] : str;
}

async function callForAngles(prompt) {
  const completion = await openRouter.chat.completions.create({
    model: 'deepseek/deepseek-r1-0528',
    messages: [
      {
        role: 'system',
        content: 'Return valid JSON only. Shape: { angles: Angle[] (3-5) }.'
      },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' } // JSON-mode!
  });

  const content = completion.choices[0].message.content;
  const cleanedContent = cleanJsonString(content);
  return JSON.parse(cleanedContent);
}

async function generateSermonOutline(
  topic,
  scripture,
  length,
  audience,
  chosenAngleTitle, // ← now a string, not an object
) {
  const res = await openRouter.chat.completions.create({
    model: 'deepseek/deepseek-r1-0528',
    temperature: 0.6,
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

/* ───────────────── Image Generation helpers ── */
async function generateImagePromptFromOutline(outline) {
  const systemPrompt = `You are an expert prompt engineer specializing in generating highly detailed and specific image prompts for sermons. Your goal is to create visually compelling and emotionally resonant prompts that capture the essence of the sermon's message, featuring diverse characters and modern settings. Follow these steps for each sermon provided:

Analyze the Sermon: Carefully review the sermon outline or content to identify the core theme, target audience, key emotions, and any specific scenes or characters that could be visualized.

Conceptualize the Image: Develop a clear mental image that encapsulates the sermon's message. Consider the setting, characters (age, ethnicity, clothing, expressions), and overall mood (e.g., hopeful, reflective, empowered).

Craft the Prompt: Write a single-sentence, highly detailed image prompt following this template:

"Create a [cinematic/photorealistic/painterly] [shot type - e.g., medium shot, close-up, panoramic] [descriptive details of setting - e.g., sun-drenched urban park, dimly lit coffee shop, modern living room] featuring [describe the focal point character(s) - e.g., a young Black woman with radiant, hopeful eyes, a diverse group of young adults in prayer]. [Describe their actions/expressions]. [Describe their clothing/appearance]. [Describe environmental details - e.g., dappled sunlight, scattered Bibles, exposed brick]. [If applicable, describe text overlay - e.g.,. The [lighting style - e.g., soft, golden hour sunlight, Edison bulb lighting] creates a [mood - e.g., hopeful, intimate, reflective] atmosphere. The color palette should be [describe dominant colors - e.g., warm, golden tones, muted blues and grays]. The overall feel is one of [overall impression - e.g., serene strength, authentic community, quiet contemplation]."

Maintain Consistency: Always output only the single-sentence image prompt string. Do not include phrases like "The photo:" or any introductory or concluding remarks. Do not output multiple sentences.

Prompt Refinement: Based on initial results, iterate on the prompt as needed to achieve the desired visual representation of the sermon. Request adjustments by providing the existing prompt and asking for specific changes.

Examples of correctly formatted prompts:

"Create a photorealistic medium shot capturing the warm atmosphere of a modern, minimalist apartment. The focus is on a young Latina woman with long, wavy hair pulled back in a messy bun, wearing an oversized knit sweater and leggings, sitting cross-legged on a plush rug. She is journaling with a focused, contemplative expression, illuminated by soft sunlight filtering through sheer curtains. A steaming mug of tea sits beside her. The lighting creates a serene and comforting atmosphere. The color palette is primarily neutral tones with pops of warm colors. The overall feel conveys a sense of peace and self-reflection."

"Create a cinematic medium shot of a bustling downtown street at twilight, focusing on a young Black man with a neatly trimmed beard and stylish glasses. He's wearing a denim jacket and a graphic t-shirt with headphones around his neck, looking upwards with a hopeful gaze. The street is alive with blurred lights and pedestrian traffic. The lighting is a mix of artificial streetlights and the fading natural light, creating a dynamic and urban atmosphere. The color palette includes deep blues, oranges, and yellows. The overall feel is one of resilience and optimism."

These examples demonstrate the desired output format and level of detail. Use them as a guideline for crafting your own prompts. Make sure you ONLY output the prompt string itself.`;

  const completion = await openRouter.chat.completions.create({
    model: 'google/gemini-2.5-flash-preview-05-20',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: outline }
    ]
  });

  return completion.choices[0].message.content.trim().replace(/\n/g, ' ');
}

async function generateImageFromPrompt(prompt) {
  try {
    console.log('Starting image generation with Replicate...');
    
    // Create prediction with exact input format from API docs
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Use the model name
        version: 'google/imagen-4-fast',
        input: {
          prompt,
          aspect_ratio: '16:9',
          output_format: 'jpg',
          safety_filter_level: 'block_only_high'
        }
      })
    });
    
    const prediction = await createResponse.json();
    console.log('Initial prediction:', JSON.stringify(prediction, null, 2));
    
    if (prediction.error) {
      throw new Error(`Prediction creation failed: ${prediction.error}`);
    }
    
    // Poll for completion
    let result = prediction;
    while (result.status === 'starting' || result.status === 'processing') {
      await new Promise((r) => setTimeout(r, 1000)); // Wait 1 second
      
      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        }
      });
      
      result = await pollResponse.json();
      console.log('Poll result status:', result.status);
    }
    
    console.log('Final prediction result:', JSON.stringify(result, null, 2));
    
    // The output should be a direct URL string according to the API docs
    if (result.status === 'succeeded' && typeof result.output === 'string') {
      console.log('Successfully generated image URL:', result.output);
      return result.output;
    }
    
    throw new Error(`Image generation failed with status: ${result.status}`);
  } catch (error) {
    console.error('Error generating image with Replicate:', error);
    console.error('Full error stack:', error.stack);
    throw new Error(`Image generation failed: ${error.message}`);
  }
}

/* ───────────────── Research + Comms helpers (unchanged) ── */
async function generateResearchAnalysis(topic) {
  try {
    const systemPrompt = 'You are a doctorate-level biblical research analyst writing for pastors and church leaders.';
    const userPrompt = `**Task**
Provide a comprehensive research analysis on the topic: **“${topic}.”**

---

### Structure (Markdown headings only)

1.  **Overview** – 150-200-word introduction.  
2.  **Key Sub-topics / Themes** – 3-5 subsections unpacking the most important historical, theological, and cultural facets.  
3.  **Illustrative Examples or Case Studies** – 1-2 concise examples that illuminate the concepts.  
4.  **Potential Resources for Further Reading** – exactly 3 carefully curated sources.  
5.  **Smart Summary / Key Takeaways** – bullet-point recap **plus** a “Pastoral Application” block (3-4 sermon-ready bullets).

---

### Content & Accuracy

- Anchor every point in **biblically orthodox, broadly accepted Christian scholarship** trusted by the modern American church (e.g., authority of Scripture, historic creeds).  
- Verify all historical details. Use parenthetical inline references—e.g., *(Deut 21:17)*; Bailey, *Poet and Peasant* (Eerdmans, 1983).  
- No speculative or fringe interpretations.

### Resource List Requirements

- Cite only pastor-trusted sources: mainstream evangelical or mainline commentaries (NICNT, WBC, Pillar), standard biblical dictionaries, respected scholars such as Kenneth E. Bailey, Craig Blomberg, Klyne Snodgrass.  
- Format each source as:  
  - Author, *Title* (Publisher, Year)

### Style & Formatting

- Write in clear, engaging prose suitable for a 60-year-old pastor: scholarly rigor without academic clutter.  
- Paragraphs ≤ 4 sentences; bullet lists welcome.  
- Target length ≈ 1,200 words unless instructed otherwise.  
- **Return only the five requested sections—no footnotes, meta-comments, or extra content.**`;

    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
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
You are an expert copywriter for Church and Ministry outreach. You have 20 years of experience in writing for churches and ministries, you know how to craft excellent copy for churches and ministries based on the target market. Generate a communication draft for the following requirements:

Communication Type: ${type}
Topic: "${topic}"
Key Points to Cover: ${keyPointsString}
Desired Tone: ${tone}
Target Audience: ${audience}

Please craft the content tailored to these specifications. Ensure the output is ready to be used for the specified communication type.
Use Markdown for formatting if appropriate for the type (e.g., for emails or event descriptions). For social media posts, keep it concise.
`;
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528',
      messages: [
        { role: 'system', content: 'You are an expert communications assistant. Generate tailored content based on the provided specifications. Return your answer in **Markdown**, US English only, no other alphabets.' },
        { role: 'user', content: prompt }
      ],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error in generateCommunicationDraft:', error);
    throw new Error(`Failed to generate communication draft: ${error.message}`);
  }
}

/* ──────────────────────────── Replicate: remove background ── */
async function removeBackground(imageBase64) {
  try {
    // 1. Create the prediction
    const prediction = await replicate.predictions.create({
      model: 'lucataco/remove-bg:95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1',
      input: {
        image: `data:image/png;base64,${imageBase64}`,
      },
    });

    console.log(`Replicate prediction created: ${prediction.id}. Status page: ${prediction.urls.get}`);

    // 2. Wait for the prediction to finish
    const completedPrediction = await replicate.wait(prediction);

    // 3. Handle the result
    if (completedPrediction.status === 'succeeded') {
      console.log('Background removal succeeded. Output URL:', completedPrediction.output);
      return completedPrediction.output;
    }

    if (completedPrediction.status === 'failed' || completedPrediction.status === 'canceled') {
      console.error('Background removal failed:', completedPrediction.error);
      throw new Error(`Background removal failed: ${completedPrediction.error}`);
    }

    throw new Error(`Background removal ended with unexpected status: ${completedPrediction.status}`);
  } catch (error) {
    console.error('Replicate API error in removeBackground:', error);
    throw new Error(`Replicate API Error: ${error.message}`);
  }
}

/* ───────────────────────────── Routes ── */

app.post('/api/remove-background', async (req, res) => {
  try {
    const { image_base64 } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: 'Missing image_base64 in request body' });
    }

    const outputUrl = await removeBackground(image_base64);
    res.json({ imageUrl: outputUrl });
  } catch (error) {
    console.error('Error in /api/remove-background:', error);
    res.status(500).json({ error: `Failed to remove background: ${error.message}` });
  }
});

app.post('/api/edit-image', async (req, res) => {
  try {
    const { prompt, input_image } = req.body;

    if (!prompt || !input_image) {
      return res.status(400).json({ error: 'Missing prompt or input_image' });
    }

    console.log('Starting image edit with Replicate...');

    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 'black-forest-labs/flux-kontext-dev',
        input: {
          prompt,
          input_image,
          aspect_ratio: 'match_input_image',
          output_format: 'png',
        },
      }),
    });

    let prediction = await createResponse.json();
    console.log('Image edit initial prediction:', JSON.stringify(prediction, null, 2));

    if (!createResponse.ok || prediction.error) {
      const errorDetail = prediction.error ? JSON.stringify(prediction.error) : `HTTP status ${createResponse.status}`;
      console.error(`Image edit prediction creation failed: ${errorDetail}`);
      return res.status(500).json({ error: `Prediction creation failed: ${errorDetail}` });
    }

    // Poll for completion
    let result = prediction;
    const maxPolls = 60; // Poll for a maximum of 60 seconds
    let pollCount = 0;

    while ((result.status === 'starting' || result.status === 'processing') && pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        },
      });

      if (!pollResponse.ok) {
        console.error(`Image edit polling failed: HTTP status ${pollResponse.status}`);
        return res.status(500).json({ error: `Polling failed: HTTP status ${pollResponse.status}` });
      }

      result = await pollResponse.json();
      console.log('Image edit poll result status:', result.status);
      pollCount++;
    }

    console.log('Image edit final prediction result:', JSON.stringify(result, null, 2));

    if (result.status === 'succeeded' && result.output) {
      const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      if (typeof imageUrl === 'string') {
        console.log('Successfully edited image URL:', imageUrl);
        return res.json({ imageUrl });
      }
    }

    const failureReason = result.error ? JSON.stringify(result.error) : `Status: ${result.status}`;
    console.error(`Image edit failed: ${failureReason}`);
    res.status(500).json({ error: `Image edit failed: ${failureReason}` });

  } catch (error) {
    console.error('Error in /api/edit-image:', error.message);
    console.error('Full error stack:', error.stack);
    res.status(500).json({ error: `Failed to edit image: ${error.message}` });
  }
});

app.post('/api/photographer', async (req, res) => {
  try {
    const { photo_input } = req.body;

    if (!photo_input) {
      return res.status(400).json({ error: 'Missing photo_input' });
    }

    const prompt =
      `The photo: Create a cinematic, photorealistic medium shot capturing ${photo_input} rendered with a shallow depth of field. Natural film grain, a warm, slightly muted color palette, authentic feel, filmic texture`;

    console.log('Starting photographer image generation with Replicate...');
    
    // Create prediction
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 'google/imagen-4-ultra', // Removed specific version hash
        input: {
          prompt,
          aspect_ratio: '16:9', // Added aspect_ratio
        },
      }),
    });

    let prediction = await createResponse.json();
    console.log('Photographer initial prediction:', JSON.stringify(prediction, null, 2));

    if (!createResponse.ok || prediction.error) {
      const errorDetail = prediction.error ? JSON.stringify(prediction.error) : `HTTP status ${createResponse.status}`;
      console.error(`Photographer prediction creation failed: ${errorDetail}`);
      return res.status(500).json({ error: `Prediction creation failed: ${errorDetail}` });
    }
    
    // Poll for completion
    let result = prediction;
    const maxPolls = 60; // Poll for a maximum of 60 seconds (adjust as needed)
    let pollCount = 0;

    while ((result.status === 'starting' || result.status === 'processing') && pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      
      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
        },
      });
      
      if (!pollResponse.ok) {
        console.error(`Photographer polling failed: HTTP status ${pollResponse.status}`);
        // Potentially handle this more gracefully, e.g. retry a few times or return error
        return res.status(500).json({ error: `Polling failed: HTTP status ${pollResponse.status}` });
      }

      result = await pollResponse.json();
      console.log('Photographer poll result status:', result.status);
      pollCount++;
    }
    
    console.log('Photographer final prediction result:', JSON.stringify(result, null, 2));
    
    if (result.status === 'succeeded' && result.output && result.output.length > 0) {
      // Assuming output is an array of URLs for imagen-4-ultra, take the first one.
      // If it's a direct string, this will also work: result.output[0] for a string 'http...' is 'h'.
      // It's safer to check if result.output is an array.
      const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      if (typeof imageUrl === 'string'){
        console.log('Successfully generated photographer image URL:', imageUrl);
        return res.json({ imageUrl });
      }
    }
    
    const failureReason = result.error ? JSON.stringify(result.error) : `Status: ${result.status}`;
    console.error(`Photographer image generation failed: ${failureReason}`);
    res.status(500).json({ error: `Image generation failed: ${failureReason}` });

  } catch (error) {
    console.error('Error in /api/photographer:', error.message);
    console.error('Full error stack:', error.stack);
    res.status(500).json({ error: `Failed to generate image: ${error.message}` });
  }
});
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

    let imageUrl = null;
    try {
      console.log('Starting image generation process...');
      const imagePrompt = await generateImagePromptFromOutline(outline);
      console.log('Generated image prompt:', imagePrompt);
      
      imageUrl = await generateImageFromPrompt(imagePrompt);
      console.log('Received image URL:', imageUrl);
    } catch (imgErr) {
      console.error('Image generation error:', imgErr);
      console.error('Full error details:', JSON.stringify(imgErr, null, 2));
    }

    console.log('Final response payload:', { outline: outline.slice(0, 100) + '...', imageUrl });
    return res.json({ outline, imageUrl });
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
          content: "You are an AI assistant specializing in creating visual concepts for church communications. Given a headline and a subheadline, generate exactly 5 distinct background image concepts for a church poster. Each concept should be a short, descriptive string (1-2 sentences). Crucially, the concepts MUST directly and specifically relate to the themes, stories, or figures mentioned in BOTH the headline and subheadline. Ensure the suggestions are varied and visually compelling. Return a JSON object with a single key 'suggestions' which contains an array of these 5 strings."
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
    const { imageBase64, imageUrl, prompt } = req.body;
    let finalBase64;

    if (imageUrl) {
      const imageBuffer = await downloadImageAsBuffer(imageUrl);
      finalBase64 = imageBuffer.toString('base64');
    } else if (imageBase64) {
      finalBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({ error: 'Missing image data: please provide either imageUrl or imageBase64.' });
    }

    const videoUrl = await animateImage(finalBase64, prompt);
    res.json({ videoUrl });
  } catch (error) {
    console.error('Error in /api/animate:', error);
    res.status(500).json({ error: error.message });
  }
});

/* ───────────────────────────── Start server ── */
app.listen(port, () => console.log(`🌟 Salt‑server listening on ${port}`));
