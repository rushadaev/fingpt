const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const app = express();
const port = process.env.PORT || 3000;

dotenv.config();
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;

        if (!file) {
            return res.status(400).send('No file uploaded.');
        }
        const mimeType = file.mimetype;

        const filePath = path.join(__dirname, file.path);

        const originalName = file.originalname;

        const tempFilePath = path.join(__dirname, file.path);

        const newFilePath = path.join(__dirname, 'uploads', originalName);

        fs.renameSync(tempFilePath, newFilePath);
        const uploadedFile = await openai.files.create({
            file: fs.createReadStream(newFilePath),
            purpose: mimeType.startsWith('image/') ? 'vision' : 'assistants',
        });

        const fileId = uploadedFile.id;
        console.log('Uploaded file with ID:', fileId);

        let assistantId = process.env.OPENAI_ASSISTANT_ID


        let messages = [];
        if (mimeType.startsWith('image/')) {
            messages = [
                {
                    role: 'user',
                    content: [
                        {
                          type: "text",
                          text: "What is on the image pls response in json format"
                        },
                        {
                            type: "image_file",
                            image_file: {
                                file_id: fileId,
                            }
                        }
                    ],
                },
            ]
        } else {
            messages = [
                {
                    role: 'user',
                    content: 'Please process the file I have uploaded.',
                    attachments: [{ file_id: fileId, tools: [{ type: "file_search" }] }],
                },
            ]
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

        res.send(responseText);

        fs.unlinkSync(newFilePath);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred while processing your request.');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
