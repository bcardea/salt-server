import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import RunwayML from '@runwayml/sdk';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configure CORS for production domains
const allowedOrigins = [
  'https://usesaltcreative.com',
  'https://www.usesaltcreative.com',
  'https://incredible-figolla-a49ac9.netlify.app'
];

// Development origins (only enabled if NODE_ENV is 'development')
if (process.env.NODE_ENV === 'development') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:8081');
}

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST'],
  credentials: true,
  maxAge: 86400 // Cache preflight request for 24 hours
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// OpenAI client for standard OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// OpenRouter client for alternative models
const openRouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://usesaltcreative.com',
    'X-Title': 'Salt Creative',
  },
});

const runway = new RunwayML({
  apiKey: process.env.RUNWAYML_API_SECRET
});

// Function to animate an image using Runway ML
async function animateImage(imageBase64) {
  try {
    console.log('Starting image animation with Runway ML...');
    
    // Create a new image-to-video task
    const imageToVideo = await runway.imageToVideo.create({
      model: 'gen4_turbo',
      promptImage: `data:image/png;base64,${imageBase64}`,
      promptText: 'KEEP ALL TEXT AND LOGOS COMPLETELY STATIC, 0% DISTORTION.  Add lifelike and cinematic animation to the primary background elements including any sky, clouds, water. looping video starts and ends on same frame.',
      ratio: '1280:720', // Standard HD 16:9 format
      duration: 5
    });

    const taskId = imageToVideo.id;
    console.log('Animation task created:', taskId);

    // Poll the task until it's complete
    let task;
    do {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
      task = await runway.tasks.retrieve(taskId);
      console.log('Task status:', task.status);
    } while (!['SUCCEEDED', 'FAILED'].includes(task.status));

    if (task.status === 'FAILED') {
      throw new Error('Animation task failed');
    }

    console.log('Animation complete');
    return task.output[0]; // Return the video URL
  } catch (error) {
    console.error('Runway ML error:', error);
    throw new Error(`Failed to animate image: ${error.message}`);
  }
}

// Generate typography with Ideogram
async function generateTypography(headline, subHeadline, style) {
  let stylePrompt = '';
  switch(style) {
    case 'focused':
      stylePrompt = 'make it focused and clean';
      break;
    case 'trendy':
      stylePrompt = 'make it fun and trendy';
      break;
    case 'kids':
      stylePrompt = 'make it for kids and childrens church - Use fun bubbly, 3D or illustrated fonts, use a white or cream color for subtitle text to ensure contrast and easy readability.';
      break;
    case 'handwritten':
      stylePrompt = 'make it handwritten';
      break;
    default:
      stylePrompt = 'make it focused and clean';
  }

  const prompt = `Create a beautifully designed modern typography for the following Church poster headline and subheadline: "${headline}: ${subHeadline}", create just the typography on a single color background, use a nice combination of fonts appropriate for modern graphic design in 2025, ${stylePrompt}`;

  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('aspect_ratio', '3x2');
  formData.append('rendering_speed', 'QUALITY');
  formData.append('magic_prompt', 'AUTO');
  formData.append('num_images', '4');
  formData.append('style_type', 'DESIGN');

  try {
    const response = await axios.post('https://api.ideogram.ai/v1/ideogram-v3/generate', formData, {
      headers: {
        ...formData.getHeaders(),
        'Api-Key': process.env.IDEOGRAM_API_KEY
      }
    });

    return response.data.data;
  } catch (error) {
    console.error('Ideogram API error:', error);
    throw new Error('Failed to generate typography');
  }
}

// Download image from URL and convert to buffer
async function downloadImageAsBuffer(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading image:', error);
    throw new Error('Failed to download image');
  }
}

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

    // Extract the enhanced prompt and format it for image generation
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

    // Use the Image Edit API with proper file formatting
    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: await toFile(fs.createReadStream(tempFilePath), 'typography.png', {
        type: "image/png",
      }),
      prompt: editPrompt,
      size: "1536x1024" // Landscape format for poster
    });

    // Clean up temp file
    fs.unlinkSync(tempFilePath);

    // The edit endpoint returns base64 by default
    console.log('Edit API response:', JSON.stringify(result.data[0], null, 2));
    
    if (result.data[0].b64_json) {
      // Convert base64 to data URL
      const base64Image = result.data[0].b64_json;
      const imageDataUrl = `data:image/png;base64,${base64Image}`;
      console.log('Successfully generated final image (base64)');
      return imageDataUrl;
    } else if (result.data[0].url) {
      // If it returns a URL instead
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
    
    // Download and analyze the typography
    const typographyBuffer = await downloadImageAsBuffer(typographyUrl);
    
    // Create a detailed prompt that describes both the typography and scene
    const generationPrompt = `Create a church poster with modern typography overlaid on ${imageDescription}. The poster should have a professional, inspiring design suitable for a church event or service. The typography should be prominent and readable against the background.`;

    // Use the Image Generation API with base64 response
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
    
    // Download the typography image
    const typographyBuffer = await downloadImageAsBuffer(typographyUrl);
    
    // Convert to base64
    const base64Typography = typographyBuffer.toString('base64');
    
    // Create the prompt
    const prompt = `Using the typography from the provided image, create a church poster with the following scene: ${imageDescription}. The typography should be prominently featured and integrated naturally into the composition.`;

    // Use the Responses API
    const response = await openai.responses.create({
      model: "gpt-4o", // or "gpt-4.1" when available
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

    // Extract the generated image
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

// Generate sermon angles using OpenRouter
async function generateSermonAngles(topic, scripture, length, audience) {
  try {
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        {
          role: 'user',
          content: `As an expert theological consultant and creative sermonic writer, generate 3-5 distinct and compelling sermon angles for a message on the topic of "${topic}" based on the scripture passage "${scripture}".
          The target audience is ${audience}, and the desired sermon length is ${length}.

          For each angle, provide:
          1.  A catchy, thought-provoking title.
          2.  A brief (1-2 sentence) summary of the core idea or "big idea" of the sermon.
          3.  A hint at the primary emotional or intellectual journey for the listener.

          The angles should be creative, theologically sound, and relevant to a modern audience. Format the output clearly, for example, using Markdown for titles and lists. Clean output only, no commentary, just the angles`
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating sermon angles:', error);
    throw error;
  }
}

// Generate detailed sermon outline using OpenRouter
async function generateSermonOutline(chosenAngle, scripture, audience, length) {
  try {
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        {
          role: 'user',
          content: `As an expert homiletics professor, create a detailed and well-structured sermon outline based on the following information:
          -   Main Angle/Big Idea: "${chosenAngle}"
          -   Primary Scripture: "${scripture}"
          -   Target Audience: ${audience}
          -   Desired Length: ${length}

          The outline should follow a clear, logical progression and include the following sections:
          1.  Introduction:
              -   An engaging hook (e.g., a story, a startling statistic, a relatable question).
              -   Briefly introduce the context of the scripture passage.
              -   Clearly state the sermon's main idea/thesis (the chosen angle).

          2.  Main Body (3-4 Points):
              -   Develop distinct, biblically-grounded points that support the main idea.
              -   For each point, suggest supporting scriptures, illustrations, or application questions.
              -   Ensure smooth transitions between points.

          3.  Conclusion:
              -   Summarize the main points concisely.
              -   Provide a clear and powerful call to action or point of reflection for the audience.
              -   End with a memorable closing statement or prayer.

          The structure should be easy to follow and practical for a pastor to preach from. Use Markdown for clear formatting (e.g., headings, nested lists). Only the outline, no commentary before or after, clean output always`
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating sermon outline:', error);
    throw error;
  }
}

// Generate in-depth research analysis
async function generateResearchAnalysis(topic) {
  try {
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        {
          role: 'user',
          content: `I want you to act as an elite research analyst with deep experience in synthesizing complex information into clear, concise insights.

Your task is to conduct a comprehensive research breakdown on the following topic:

${topic}

Here's how I want you to proceed:

1. Start with a brief, plain-English overview of the topic.
2. Break the topic into 3–5 major sub-topics or components.
3. For each sub-topic, provide:
   - A short definition or explanation
   - Key facts, trends, or recent developments
   - Any major debates or differing perspectives
4. Include notable data, statistics, or real-world examples where relevant.
5. Recommend 3–5 high-quality resources for further reading (articles, papers, videos, or tools).
6. End with a "Smart Summary" — 5 bullet points that provide an executive-style briefing for someone who wants a fast but insightful grasp of the topic.

Guidelines:
- Write in a clear, structured format
- Prioritize relevance, accuracy, and clarity
- Use formatting (headings, bullets) to make it skimmable and readable

Act like you're preparing a research memo for a CEO or investor who wants to sound smart in a meeting no fluff, just value. Only deliver the response, no commentary before or after, never identify yourself or conversationally respond, just high-detailed ouput that follows my instructions exactly`
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating research analysis:', error);
    throw error;
  }
}

// Get communication type instructions
function getTypeInstructions(type) {
  switch (type) {
    case 'social-facebook':
      return 'The platform is Facebook. The post should be engaging, encouraging comments and shares. It can be a few paragraphs long. Use a friendly and approachable tone. Consider adding a question to spark discussion.';
    case 'social-twitter':
      return 'The platform is Twitter (now X). The post must be concise and under 280 characters. Use relevant hashtags. The tone should be punchy and direct.';
    case 'social-instagram':
      return 'The platform is Instagram. The post should have a visually descriptive and compelling caption. Include relevant hashtags at the end. The tone should be inspiring and personal.';
    case 'email-newsletter':
      return 'This is a weekly newsletter email. It should have a clear structure with a welcoming introduction, a body that elaborates on the key points, and a warm closing. The tone should be informative yet personal.';
    case 'email-thankyou':
      return 'This is a thank-you email for church volunteers. It should be heartfelt and specific, acknowledging their contribution and impact. The tone should be sincere and appreciative.';
    case 'email-announcement':
      return 'This is a community announcement email. It should be clear, concise, and provide all necessary information (what, when, where, why). The tone should be professional and informative.';
    case 'event-description':
      return 'This is a description for a church event. It should be exciting and compelling to encourage attendance. Highlight the key activities and the purpose of the event. The tone should be enthusiastic and welcoming.';
    default:
      return 'This is a general communication draft.';
  }
}

// Generate communication draft
async function generateCommunicationDraft(type, topic, keyPoints, tone, audience) {
  try {
    const instructions = getTypeInstructions(type);
    const completion = await openRouter.chat.completions.create({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
      messages: [
        {
          role: 'user',
          content: `You are an expert communications assistant for a church pastor. Your task is to write a draft for a specific purpose.

Communication Type: ${type}
Topic/Event: ${topic}
Key Points to Include: ${keyPoints}
Desired Tone: ${tone}
Target Audience: ${audience}

Specific Instructions for this format:
${instructions}

Please write the complete draft now.`
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating communication draft:', error);
    throw error;
  }
}

// API Endpoints

// Depth endpoint for research analysis
app.post('/api/depth', async (req, res) => {
  try {
    const { research_topic } = req.body;

    if (!research_topic) {
      return res.status(400).json({ error: 'research_topic is required' });
    }

    const analysis = await generateResearchAnalysis(research_topic);
    res.json({ analysis });
  } catch (error) {
    console.error('Error in depth endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Flavor endpoint for sermon generation
app.post('/api/flavor', async (req, res) => {
  try {
    const { topic, scripture, length, audience, chosenAngle } = req.body;

    if (chosenAngle) {
      // Generate detailed outline for chosen angle
      const outline = await generateSermonOutline(chosenAngle, scripture, audience, length);
      res.json({ outline });
    } else {
      // Generate initial sermon angles
      const angles = await generateSermonAngles(topic, scripture, length, audience);
      res.json({ angles });
    }
  } catch (error) {
    console.error('Error in flavor endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aroma endpoint for communication drafts
app.post('/api/aroma', async (req, res) => {
  try {
    const { type, topic, keyPoints, tone, audience } = req.body;

    // Validate required fields
    if (!type || !topic || !keyPoints || !tone || !audience) {
      return res.status(400).json({ 
        error: 'Missing required fields. Please provide: type, topic, keyPoints, tone, audience' 
      });
    }

    // Validate communication type
    const validTypes = [
      'social-facebook', 'social-twitter', 'social-instagram',
      'email-newsletter', 'email-thankyou', 'email-announcement',
      'event-description'
    ];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        error: 'Invalid type. Must be one of: ' + validTypes.join(', ') 
      });
    }

    const draft = await generateCommunicationDraft(type, topic, keyPoints, tone, audience);
    res.json({ draft });
  } catch (error) {
    console.error('Error in aroma endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

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

    // Forward the content-type header
    res.set('Content-Type', response.headers['content-type']);
    
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Pipe the image data to the response
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
    const suggestions = result.suggestions || result.ideas || Object.values(result)[0];

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
        // Use the Image Edit API (default)
        finalImage = await generateFinalImage(typographyUrl, imageDescription);
        break;
      case 'generate':
        // Use the Image Generation API (doesn't use typography as input)
        finalImage = await generateFinalImageAlternative(typographyUrl, imageDescription);
        break;
      case 'responses':
        // Use the Responses API (uses typography as input)
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

    // Remove the data:image/png;base64, prefix if present
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    
    // Animate the image
    const videoUrl = await animateImage(cleanBase64);
    res.json({ videoUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
