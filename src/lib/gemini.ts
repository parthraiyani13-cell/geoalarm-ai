import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

export async function parseAlarmText(text: string): Promise<{ location: string; radiusMeters: number }> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Extract the target location and the radius in meters from the following text. 
    The location should be a searchable string for a map API (like "Central Park, NY" or "Eiffel Tower"). 
    If the text contains personal references like "my office" or "home" without a specific address, return the most likely public place name mentioned or just the name itself.
    If the text doesn't specify a radius, default to 1000 meters. 
    If the text says something like "2km", convert it to 2000 meters.
    
    Text: "${text}"`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          location: {
            type: Type.STRING,
            description: "The target location mentioned in the text.",
          },
          radiusMeters: {
            type: Type.NUMBER,
            description: "The radius in meters.",
          },
        },
        required: ["location", "radiusMeters"],
      },
    },
  });
  
  if (!response.text) {
    throw new Error("Failed to parse text");
  }
  
  return JSON.parse(response.text);
}
