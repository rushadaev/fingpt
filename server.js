const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const Bull = require('bull');
const Redis = require('ioredis');

const app = express();
const port = process.env.PORT || 3000;

dotenv.config();
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
});

// Redis client for storing and retrieving results
const redisClient = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
});

// Bull queue for background processing
const processingQueue = new Bull('processingQueue', {
    redis: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    },
});

// Route for uploading files
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;

        if (!file) {
            return res.status(400).send('No file uploaded.');
        }

        const mimeType = file.mimetype;
        const originalName = file.originalname;
        const tempFilePath = path.join(__dirname, file.path);
        const newFilePath = path.join(__dirname, 'uploads', originalName);
        fs.renameSync(tempFilePath, newFilePath);

        // Add job to Bull queue
        const job = await processingQueue.add({
            filePath: newFilePath,
            mimeType: mimeType,
            originalName: originalName,
        });

        // Return job ID instantly
        res.json({ jobId: job.id });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred while processing your request.');
    }
});

// Route for polling job result
app.get('/result/:jobId', async (req, res) => {
    const jobId = req.params.jobId;

    try {
        // Try to get the result from Redis
        const result = await redisClient.get(`result:${jobId}`);

        if (result) {
            res.json({ status: 'completed', result: JSON.parse(result) });
        } else {
            // Check job status
            const job = await processingQueue.getJob(jobId);
            if (job) {
                const state = await job.getState();
                res.json({ status: state });
            } else {
                res.status(404).json({ error: 'Job not found' });
            }
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred while retrieving your result.');
    }
});

// Bull queue processor
processingQueue.process(async (job) => {
    const { filePath, mimeType, originalName } = job.data;

    try {
        const uploadedFile = await openai.files.create({
            file: fs.createReadStream(filePath),
            purpose: mimeType.startsWith('image/') ? 'vision' : 'assistants',
        });

        const fileId = uploadedFile.id;
        console.log('Uploaded file with ID:', fileId);

        let assistantId = process.env.OPENAI_ASSISTANT_ID;

        let messages = [];
        if (mimeType.startsWith('image/')) {
            messages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: "text",
                            text: "What is on the image? Please respond in JSON format."
                        },
                        {
                            type: "image_file",
                            image_file: {
                                file_id: fileId,
                            }
                        }
                    ],
                },
            ];
        } else {
            messages = [
                {
                    role: 'user',
                    content: 'Please process the file I have uploaded.',
                    attachments: [{ file_id: fileId, tools: [{ type: "file_search" }] }],
                },
            ];
        }

        const thread = await openai.beta.threads.create({
            messages: messages,
        });

        let threadId = thread.id;
        console.log('Created thread with Id:', threadId);

        let responseText = '';

        const run = openai.beta.threads.runs
            .stream(threadId, {
                assistant_id: assistantId,
            })
            .on('textDelta', (delta, snapshot) => {
                responseText = snapshot;
                console.log(snapshot);
            });

        await run.finalRun();

        // Save result in Redis
        await redisClient.set(`result:${job.id}`, JSON.stringify(responseText));

        // Clean up uploaded file
        fs.unlinkSync(filePath);

        return Promise.resolve();

    } catch (error) {
        console.error('Error:', error);

        // Clean up uploaded file
        fs.unlinkSync(filePath);

        return Promise.reject(error);
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
