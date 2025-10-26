require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const ImageKit = require('imagekit');
const bodyParser = require('body-parser');

const Image = require('./models/Image'); // Assuming you have a separate file for the model

const app = express();
const PORT = process.env.PORT || 5000;

// --- CONFIGURATION ---

// Increase limit to handle large Base64 image payloads (100MB)
app.use(bodyParser.json({
    limit: '100mb'
}));
app.use(bodyParser.urlencoded({
    extended: true,
    limit: '100mb'
}));
app.use(cors());


// Simple request logger
app.use((req, res, next) => {
    try {
        const contentLength = req.headers['content-length'] || 'unknown';
        console.log(`[REQ] ${req.method} ${req.url} - Content-Length: ${contentLength}`);
    } catch (e) {
        /* noop */
    }
    next();
});

// Setup ImageKit
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
        // Do not throw here, allow server to start, but log the error
    }
}

connectDB().catch(() => {});

// --- ROUTES ---

// Health check endpoint
app.get('/', (req, res) => res.json({
    ok: true,
    message: 'Server is running.'
}));

// Test Upload Route
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
        console.error('[TEST-UPLOAD] error', err);
        // Always return a JSON error response
        return res.status(500).json({
            ok: false,
            error: err.message || 'ImageKit Test Upload Failed'
        });
    }
});


// Main Upload Route
app.post('/api/upload', async (req, res) => {
    // Check for large payload early
    if (req.headers['content-length'] > 100 * 1024 * 1024) { // 100MB check
        return res.status(413).json({
            success: false,
            error: 'Request body exceeded server size limit (100MB).'
        });
    }

    try {
        const {
            images
        } = req.body;

        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No images provided in the request body.'
            });
        }

        const results = [];

        for (let i = 0; i < images.length; i++) {
            const item = images[i];
            const src = item.src;
            const filter = item.filter || null;

            if (!src || typeof src !== 'string' || src.length < 100) {
                results.push({
                    uploaded: false,
                    error: 'Invalid or too small image data'
                });
                continue;
            }

            // Strip data URL prefix if present
            const base64 = src.startsWith('data:') ? src.split(',')[1] : src;

            const fileName = `photo_${Date.now()}_${i}.jpg`;

            try {
                console.log(`[IMG] index=${i} filter=${filter} base64Length=${base64.length}`);
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
                console.error('[IMAGEKIT] upload error for', fileName, uploadErr);
                results.push({
                    uploaded: false,
                    error: uploadErr.message || String(uploadErr)
                });
            }
        }

        return res.json({
            success: true,
            results,
            message: 'Processing complete. Check results array for individual status.'
        });
    } catch (err) {
        // Always return a JSON error response, which prevents 'Unexpected end of JSON input' on client
        console.error('[UPLOAD] fatal error', err);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error during upload processing.',
            details: err.message || String(err)
        });
    }
});

// --- ERROR HANDLING MIDDLEWARE ---

app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);

    // Catch bodyParser / payload too large errors
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({
            success: false,
            error: 'Payload too large',
            details: 'Request body exceeded the configured size limit (100MB).'
        });
    }

    // Generic JSON error fallback
    return res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message || 'An unknown internal error occurred.'
    });
});

// --- SERVER STARTUP ---

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- GRACEFUL SHUTDOWN ---

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