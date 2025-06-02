import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
      stylePrompt = 'make it for kids and children\'s church';
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
          content: "You are a professional photographer and designer. Your task is to enhance image descriptions into detailed prompts for an AI image generator. The prompt should focus on creating a beautiful, well-lit photo that works as a poster backdrop with the typography overlaid."
        },
        {
          role: "user",
          content: `Create a detailed prompt for this scene: ${imageDescription}`
        }
      ]
    });

    // Extract the enhanced prompt and format it for image generation
    const enhancedDescription = response.choices[0].message.content;
    const editPrompt = `Take the text from the uploaded image and place it cleanly and nicely with grain and a bit of depth of field in a beautifully shot and lit photo of ${enhancedDescription}. Tasteful and attractive noise and degrading on the image. Used as the backdrop for a poster so have appropriate negative space in the middle.`;

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

// API Endpoints
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
