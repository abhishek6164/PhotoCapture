require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const ImageKit = require('imagekit');
const bodyParser = require('body-parser');

const Image = require('./models/Image');

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(bodyParser.json({
    limit: '50mb'
}));
app.use(bodyParser.urlencoded({
    extended: true,
    limit: '50mb'
}));

// Simple request logger to help debugging on Render
app.use((req, res, next) => {
    try {
        console.log(`[REQ] ${req.method} ${req.url} - Content-Length: ${req.headers['content-length'] || 'unknown'}`);
    } catch (e) {
        /* noop */
    }
    next();
});

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
        console.error('MONGODB_URI not set in .env');
        return;
    }
    try {
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        throw err;
    }
}

connectDB().catch(() => {});

// Health

// Quick test endpoint to verify ImageKit and DB from the deployed server
app.post('/api/test-upload', async (req, res) => {
    // a tiny 1x1 PNG base64 (no data: prefix)
    const tinyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    const fileName = `test_${Date.now()}.png`;
    try {
        const uploadResponse = await imagekit.upload({
            file: tinyBase64,
            fileName,
            useUniqueFileName: true
        });
        const doc = await Image.create({
            url: uploadResponse.url,
            fileId: uploadResponse.fileId,
            fileName: uploadResponse.name || fileName
        });
        return res.json({
            ok: true,
            uploadResponse,
            docId: doc._id
        });
    } catch (err) {
        console.error('[TEST-UPLOAD] error', err && err.message ? err.message : err);
        return res.status(500).json({
            ok: false,
            error: err && err.message ? err.message : String(err)
        });
    }
});
app.get('/', (req, res) => res.json({
    ok: true
}));

// Upload route - accepts array of images or single image
// Expected body: { images: [{ src: 'data:image/jpeg;base64,...', filter: '90s' }, ...] }
app.post('/api/upload', async (req, res, next) => {
    try {
        const {
            images
        } = req.body;
        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No images provided'
            });
        }

        const results = [];

        for (let i = 0; i < images.length; i++) {
            const item = images[i];
            const src = item.src;
            const filter = item.filter || null;

            if (!src || typeof src !== 'string') {
                results.push({
                    uploaded: false,
                    error: 'Invalid image data'
                });
                continue;
            }

            // Strip data URL prefix if present
            const base64 = src.startsWith('data:') ? src.split(',')[1] : src;

            const fileName = `photo_${Date.now()}_${i}.jpg`;

            // Log approximate size for this image (helps detect truncation issues)
            try {
                console.log(`[IMG] index=${i} filter=${filter} srcLength=${src.length}`);
            } catch (e) {
                /* ignore */
            }

            // Upload to ImageKit with per-image error handling
            try {
                const uploadResponse = await imagekit.upload({
                    file: base64,
                    fileName,
                    useUniqueFileName: true
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
            } catch (uploadErr) {
                console.error('[IMAGEKIT] upload error for', fileName, uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
                results.push({
                    uploaded: false,
                    error: uploadErr && uploadErr.message ? uploadErr.message : String(uploadErr)
                });
            }
        }

        return res.json({
            success: true,
            results
        });
    } catch (err) {
        // Always return a JSON error response
        console.error('[UPLOAD] fatal error', err && err.message ? err.message : err);
        return res.status(500).json({
            success: false,
            error: err && err.message ? err.message : String(err)
        });
    }
});

// Error handling middleware - return JSON for bodyParser / payload errors and others
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err && err.message ? err.message : err);
    // body-parser uses 'entity.too.large' or sets status 413 for payload too large
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({
            error: 'Payload too large',
            details: err.message || 'Request body exceeded size limit'
        });
    }

    // Generic JSON error
    return res.status(500).json({
        error: 'Internal server error',
        details: err ? err.message : 'unknown'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown (helps nodemon / Ctrl+C behavior and returns proper exit codes)
const shutdown = async (signal) => {
    try {
        console.log(`Received ${signal} — closing MongoDB connection...`);
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