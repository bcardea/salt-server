# Church Poster Generator API

This API service generates church posters by combining beautiful typography with atmospheric backgrounds using Ideogram and OpenAI's GPT-4 Vision.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Add your OpenAI API key
   - Add your Ideogram API key

3. Start the server:
```bash
npm start
```

## API Endpoints

### Generate Typography
```http
POST /api/generate-typography
Content-Type: application/json

{
  "headline": "Sunday Service",
  "subHeadline": "Join us for worship"
}
```

### Generate Final Image
```http
POST /api/generate-final
Content-Type: application/json

{
  "typographyUrl": "url_from_previous_step",
  "imageDescription": "In front of stormy waves and a dark stormy sky"
}
```

## Deployment

This API is designed to be deployed to Render.com. Follow these steps:

1. Create a new Web Service on Render
2. Connect your repository
3. Set the following:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add your environment variables in the Render dashboard
5. Deploy!
