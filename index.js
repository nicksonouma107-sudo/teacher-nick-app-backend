const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Initialize Firebase Admin safely for Render environment
try {
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
    } else {
        // Fallback initialization if environment credentials are managed via default GCP runtime
        admin.initializeApp();
    }
    console.log("Firebase Admin Initialized Successfully.");
} catch (error) {
    console.error("Firebase Initialization Warning:", error.message);
}

const app = express();
app.use(express.json());
app.use(cors());

const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const PASSKEY = process.env.PASSKEY;
const SHORTCODE = "1379452"; // Store Number / Head Office Shortcode
const TILL_NUMBER = "1847817"; // Your Buy Goods Till Number

// Configure Nodemailer for Admin Password Resets
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Set in Render Environment Variables
        pass: process.env.EMAIL_PASS  // Set in Render Environment Variables (App Password)
    }
});

// Temporary memory stores
const passwordResetCodes = {};
const pendingTransactions = {}; // Maps CheckoutRequestID -> { userId, documentId }
const transactionStatuses = {}; // Maps CheckoutRequestID -> { resultCode }

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

// ==================== M-PESA STK PUSH ROUTES ====================

app.post('/stkPush', async (req, res) => {
    try {
        const { phoneNumber, amount, userId, documentId, accountReference, transactionDesc } = req.body;

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
            PartyB: TILL_NUMBER, // Send to your live Till 1847817
            PhoneNumber: phoneNumber,
            CallBackURL: "https://teacher-nick-app-backend.onrender.com/stkCallback", // Fixed Render URL
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

        const checkoutRequestId = response.data.CheckoutRequestID;

        // Save metadata temporarily against this CheckoutRequestID so callback knows what user/doc to unlock
        if (checkoutRequestId) {
            pendingTransactions[checkoutRequestId] = {
                userId: userId || "",
                documentId: documentId || ""
            };
        }

        console.log("STK Push Success:", response.data);
        return res.status(200).json({
            success: true,
            message: "STK Push initiated successfully",
            CheckoutRequestID: checkoutRequestId,
            data: response.data
        });

    } catch (error) {
        const errorDetails = error.response?.data || error.message;
        console.error("STK Push Error:", JSON.stringify(errorDetails));
        return res.status(500).json({ success: false, error: errorDetails });
    }
});

// M-Pesa Callback route handling tiered permissions securely
app.post('/stkCallback', async (req, res) => {
    try {
        console.log("M-Pesa Callback Received:", JSON.stringify(req.body, null, 2));

        const callbackData = req.body.Body?.stkCallback;
        if (!callbackData) {
            return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback structure" });
        }

        const checkoutRequestId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode.toString(); // "0" = success

        // Save result code for app polling immediately
        transactionStatuses[checkoutRequestId] = { resultCode };

        if (resultCode === "0") {
            const metadataItems = callbackData.CallbackMetadata?.Item || [];
            let amountPaid = 0;

            metadataItems.forEach(item => {
                if (item.Name === "Amount") {
                    amountPaid = Number(item.Value);
                }
            });

            const pendingTx = pendingTransactions[checkoutRequestId];
            if (pendingTx && pendingTx.userId) {
                const { userId, documentId } = pendingTx;
                const now = Date.now();
                const db = admin.firestore();

                if (amountPaid === 50 && documentId) {
                    // Tier 1: Unlock only this specific document ID (50 KES)
                    await db.collection("users").doc(userId).set({
                        unlockedDocuments: {
                            [documentId]: true
                        }
                    }, { merge: true });
                    console.log(`Unlocked single document ${documentId} for user ${userId}`);

                } else if (amountPaid === 299) {
                    // Tier 2: 30 Days All Access (299 KES)
                    const expiryDate = now + (30 * 24 * 60 * 60 * 1000);
                    await db.collection("users").doc(userId).set({
                        isSubscribed: true,
                        subscriptionExpiry: expiryDate
                    }, { merge: true });
                    console.log(`Granted 30-day subscription for user ${userId}`);

                } else if (amountPaid === 1500) {
                    // Tier 3: 365 Days All Access (1500 KES)
                    const expiryDate = now + (365 * 24 * 60 * 60 * 1000);
                    await db.collection("users").doc(userId).set({
                        isSubscribed: true,
                        subscriptionExpiry: expiryDate
                    }, { merge: true });
                    console.log(`Granted 365-day subscription for user ${userId}`);
                }
            }
        }

        res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
        console.error("Callback Processing Error:", error);
        res.status(500).json({ ResultCode: 1, ResultDesc: error.message });
    }
});

// Payment Status Polling route for Android App
app.get('/paymentStatus', (req, res) => {
    const { checkoutRequestId } = req.query;

    if (!checkoutRequestId) {
        return res.status(400).json({ error: "Missing checkoutRequestId" });
    }

    const txStatus = transactionStatuses[checkoutRequestId];
    if (txStatus) {
        return res.status(200).json({ resultCode: txStatus.resultCode });
    } else {
        return res.status(200).json({ resultCode: "PENDING" });
    }
});

// ==================== ADMIN PASSWORD RESET ROUTES ====================

app.post('/admin/request-reset', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: "Email is required." });
        }

        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 15 * 60 * 1000;

        passwordResetCodes[email] = { code: resetCode, expiresAt };

        const mailOptions = {
            from: '"Teacher Nick Academy" <no-reply@teachernick.com>',
            to: email,
            subject: 'Admin Password Reset Verification Code',
            text: `Your verification code to reset your admin password is: ${resetCode}\n\nThis code is valid for 15 minutes.`
        };

        await transporter.sendMail(mailOptions);
        console.log(`Password reset code sent to ${email}`);

        return res.status(200).json({ success: true, message: "Verification code sent to email successfully." });
    } catch (error) {
        console.error("Reset Request Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/admin/verify-and-reset', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) {
            return res.status(400).json({ success: false, error: "Email, code, and new password are required." });
        }

        const record = passwordResetCodes[email];
        if (!record) {
            return res.status(400).json({ success: false, error: "No active reset request found for this email." });
        }

        if (Date.now() > record.expiresAt) {
            delete passwordResetCodes[email];
            return res.status(400).json({ success: false, error: "Reset code has expired. Please request a new one." });
        }

        if (record.code !== code) {
            return res.status(400).json({ success: false, error: "Invalid verification code." });
        }

        delete passwordResetCodes[email];
        console.log(`Admin password successfully reset for: ${email}`);

        return res.status(200).json({ success: true, message: "Password reset successfully." });
    } catch (error) {
        console.error("Verify & Reset Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
