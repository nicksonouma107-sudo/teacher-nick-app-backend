const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const PASSKEY = process.env.PASSKEY;
const SHORTCODE = "1847817";

app.get('/', (req, res) => {
    res.send('Teacher Nick Academy Backend is running live 24/7!');
});

async function getAccessToken() {
    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
        throw new Error("Missing CONSUMER_KEY or CONSUMER_SECRET in Render.");
    }
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get(
            'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { authorization: `Basic ${auth}` } }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Error generating access token:', error.response?.data || error.message);
        throw new Error(error.response?.data?.errorMessage || 'Failed to authenticate with Safaricom API');
    }
}

app.post('/stkPush', async (req, res) => {
    try {
        const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

        if (!phoneNumber || !amount) {
            return res.status(400).json({ success: false, error: "Phone number and amount are required." });
        }

        if (!PASSKEY) {
            return res.status(500).json({ success: false, error: "PASSKEY environment variable is not configured." });
        }

        const accessToken = await getAccessToken();

        const now = new Date();
        const nairobiTime = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Nairobi" }));

        const timestamp = nairobiTime.getFullYear().toString() +
            String(nairobiTime.getMonth() + 1).padStart(2, '0') +
            String(nairobiTime.getDate()).padStart(2, '0') +
            String(nairobiTime.getHours()).padStart(2, '0') +
            String(nairobiTime.getMinutes()).padStart(2, '0') +
            String(nairobiTime.getSeconds()).padStart(2, '0');

        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

        const stkPayload = {
            BusinessShortCode: SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerBuyGoodsOnline",
            Amount: Math.round(Number(amount)),
            PartyA: phoneNumber,
            PartyB: SHORTCODE,
            PhoneNumber: phoneNumber,
            CallBackURL: "https://teachernick-backend.onrender.com/stkCallback",
            AccountReference: accountReference || "TeacherNick",
            TransactionDesc: transactionDesc || "Academy Subscription"
        };

        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkPayload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log("STK Push Success:", response.data);
        return res.status(200).json({
            success: true,
            message: "STK Push initiated successfully",
            data: response.data
        });

    } catch (error) {
        const errorDetails = error.response?.data || error.message;
        console.error("STK Push Error:", JSON.stringify(errorDetails));
        return res.status(500).json({ success: false, error: errorDetails });
    }
});

app.post('/stkCallback', (req, res) => {
    console.log("M-Pesa Callback Received:", JSON.stringify(req.body, null, 2));
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
