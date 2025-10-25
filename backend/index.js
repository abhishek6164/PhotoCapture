require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const ImageKit = require("imagekit");
const bodyParser = require("body-parser");

const Image = require("./models/Image");

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(bodyParser.json({
    limit: "12mb"
}));
app.use(bodyParser.urlencoded({
    extended: true,
    limit: "12mb"
}));

// Setup ImageKit (trim env values to avoid accidental whitespace in .env)
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY ?
    process.env.IMAGEKIT_PUBLIC_KEY.trim() :
    undefined;
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY ?
    process.env.IMAGEKIT_PRIVATE_KEY.trim() :
    undefined;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT ?
    process.env.IMAGEKIT_URL_ENDPOINT.trim() :
    undefined;

const imagekit = new ImageKit({
    publicKey: IMAGEKIT_PUBLIC_KEY,
    privateKey: IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
});

// Connect to MongoDB
async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("MONGODB_URI not set in .env");
        return;
    }
    // modern mongoose doesn't require the legacy options; keep it simple
    await mongoose.connect(uri);
    console.log("Connected to MongoDB");
}

connectDB().catch((err) => {
    console.error("MongoDB connection error:", err);
});

// Health
app.get("/", (req, res) => res.json({
    ok: true
}));

// Upload route - accepts array of images or single image
// Expected body: { images: [{ src: 'data:image/jpeg;base64,...', filter: '90s' }, ...] }
app.post("/api/upload", async (req, res) => {
    try {
        const {
            images
        } = req.body;
        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({
                error: "No images provided"
            });
        }

        const results = [];

        for (let i = 0; i < images.length; i++) {
            const item = images[i];
            const src = item.src;
            const filter = item.filter || null;

            if (!src || typeof src !== "string") continue;

            // Strip data URL prefix if present
            const base64 = src.startsWith("data:") ? src.split(",")[1] : src;

            const fileName = `photo_${Date.now()}_${i}.jpg`;

            // Upload to ImageKit
            const uploadResponse = await imagekit.upload({
                file: base64,
                fileName,
                useUniqueFileName: true,
            });

            // Save to MongoDB
            const doc = await Image.create({
                url: uploadResponse.url,
                fileId: uploadResponse.fileId,
                fileName: uploadResponse.name || fileName,
                filter,
                meta: {
                    width: uploadResponse.width,
                    height: uploadResponse.height
                },
            });

            results.push({
                uploaded: true,
                url: uploadResponse.url,
                id: doc._id
            });
        }

        res.json({
            success: true,
            results
        });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({
            error: "Upload failed",
            details: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown (helps nodemon / Ctrl+C behavior and returns proper exit codes)
const shutdown = async (signal) => {
    try {
        console.log(`Received ${signal} — closing server and MongoDB connection...`);
        await mongoose.disconnect();
        console.log('MongoDB disconnected');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown', err);
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));