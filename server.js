/*
// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable trust proxy
app.set('trust proxy', 1);

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log("MongoDB connected successfully.");
})
.catch((err) => {
    console.error("MongoDB connection error:", err);
});

// Session management with MongoDB store
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI, // MongoDB URI from .env
        collectionName: 'sessions',
        ttl: 30 * 60 // 30 minutes
    }),
    cookie: {
        secure: false, // Set to true if you're using HTTPS
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 60 * 1000 // 30 minutes in milliseconds
    }
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(helmet());
app.use(cors());

// Configure SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Rate limiting for login attempts
const loginLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, please try again after 30 minutes.'
});

// User Schema
const userSchema = new mongoose.Schema({
    emaildb: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resetKey: String,
    resetExpires: Date,
});
const User = mongoose.model('User', userSchema);

// Token Schema (for storing the reset token)
const tokenSchema = new mongoose.Schema({
    email: { type: String, required: true },
    token: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 3600 }, // Token expires in 1 hour
});
const Token = mongoose.model('Token', tokenSchema);

// Helper Functions
async function hashPassword(password) {
    const saltRounds = 10;
    return await bcrypt.hash(password, saltRounds);
}

function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// Send Reset Code Email
async function sendResetCodeEmail(email, resetCode) {
    const msg = {
        to: email,
        from: 'balicweyjohnwell@gmail.com', // Replace with your verified SendGrid email
        subject: 'Your Password Reset Code',
        text: `Your password reset code is: ${resetCode}`,
        html: `<p>Your password reset code is:</p><h3>${resetCode}</h3>`,
    };
    await sgMail.send(msg);
}

// Sign Up Route
app.post('/signup', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        const existingUser = await User.findOne({ emaildb: email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email already registered.' });
        }

        const hashedPassword = await hashPassword(password);
        const newUser = new User({
            emaildb: email,
            password: hashedPassword,
            createdAt: new Date(),
        });

        await newUser.save();
        res.json({ success: true, message: 'Account created successfully!' });
    } catch (error) {
        console.error('Error creating account:', error.stack || error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// Forgot Password Route (store token in MongoDB)
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json('Email is required');
    }

    try {
        // Check if the user exists in the User collection
        const user = await User.findOne({ emaildb: email });
        if (!user) {
            return res.status(404).json({ message: 'No account with that email exists' });
        }

        // Generate a 6-character reset code
        const resetCode = generateRandomString(6);

        // Save the reset code and its expiration time in the User collection
        user.resetKey = resetCode;
        user.resetExpires = new Date(Date.now() + 3600000); // 1-hour expiry
        await user.save();

        // Generate a secure token to store in the Token collection
        const resetToken = generateRandomString(32);

        // Check if there's already an existing token for this user in the Token collection
        let existingToken = await Token.findOne({ email });
        if (existingToken) {
            // If the token exists, update it
            existingToken.token = resetToken;
            existingToken.createdAt = new Date();  // Update the creation time to reset the expiration
            await existingToken.save();
        } else {
            // Otherwise, create a new token entry in the Token collection
            const newToken = new Token({ email, token: resetToken });
            await newToken.save();
        }

        // Send the reset code via email using SendGrid
        await sendResetCodeEmail(email, resetCode);

        // Respond to the client
        res.json({ message: 'Password reset code sent', redirectUrl: '/reset-password.html' });
    } catch (error) {
        console.error('Error processing forgot-password request:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
});

// Send Password Reset Route
app.post('/send-password-reset', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ emaildb: email });
        if (!user) {
            return res.status(404).json({ message: 'No account with that email exists' });
        }

        const resetCode = generateRandomString(6);
        user.resetKey = resetCode;
        user.resetExpires = new Date(Date.now() + 3600000); // 1-hour expiry
        await user.save();

        const resetToken = generateRandomString(32); // This token will be stored in the Token collection

        let existingToken = await Token.findOne({ email });
        if (existingToken) {
            existingToken.token = resetToken;
            await existingToken.save();
        } else {
            const newToken = new Token({ email, token: resetToken });
            await newToken.save();
        }

        await sendResetCodeEmail(email, resetCode);
        res.json({ message: 'Password reset code sent', redirectUrl: '/reset-password.html' });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
});

// Reset Password Route
app.post('/reset-password', async (req, res) => {
    const { resetKey, newPassword } = req.body;
    try {
        const user = await User.findOne({
            resetKey,
            resetExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset key.' });
        }

        const hashedPassword = await hashPassword(newPassword);
        user.password = hashedPassword;
        user.resetKey = null;
        user.resetExpires = null;
        await user.save();

        res.json({ success: true, message: 'Your password has been successfully reset.' });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ success: false, message: 'Error resetting password' });
    }
});

// Login Route
app.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
        if (!validator.isEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email format.' });

        const user = await User.findOne({ emaildb: email });
        if (!user) return res.status(400).json({ success: false, message: 'Invalid email or password.' });

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            let invalidAttempts = (user.invalidLoginAttempts || 0) + 1;
            let updateFields = { invalidLoginAttempts: invalidAttempts };

            if (invalidAttempts >= 3) {
                updateFields.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
                updateFields.invalidLoginAttempts = 0;
                await User.updateOne({ _id: user._id }, { $set: updateFields });
                return res.status(403).json({ success: false, message: 'Account is locked due to multiple failed login attempts. Please try again after 30 minutes.' });
            } else {
                await User.updateOne({ _id: user._id }, { $set: updateFields });
                return res.status(400).json({ success: false, message: 'Invalid email or password.' });
            }
        }

        // Store user info in the session to allow greetings
        req.session.user = { email: user.emaildb };

        await User.updateOne(
            { _id: user._id },
            { $set: { invalidLoginAttempts: 0, accountLockedUntil: null, lastLoginTime: new Date() } }
        );
        res.json({ success: true, message: `Hello, ${user.emaildb}!` });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Route to get user details (for greeting message)
app.get('/user-details', (req, res) => {
    if (req.session.user) {
        const userEmail = req.session.user.email;
        res.json({ success: true, message: `Hello, ${userEmail}!` });
    } else {
        res.json({ success: false, message: 'You are not logged in.' });
    }
});

// Logout Route
app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Failed to log out' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
*/

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));
app.use(helmet());
app.use(cors());
app.set('trust proxy', 1);

// MongoDB URI and Session Secret Validation
const mongoUri = process.env.MONGODB_URI;
const sessionSecret = process.env.SESSION_SECRET;
if (!mongoUri || !sessionSecret) {
    console.error('Required environment variables (MONGODB_URI or SESSION_SECRET) are missing.');
    process.exit(1);
}

// MongoClient Connection
const client = new MongoClient(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
client.connect().then(() => {
    console.log('MongoDB connected successfully.');
}).catch((err) => {
    console.error('MongoDB connection error:', err);
});

const db = client.db('mydb');  // Change this to your database name

// Session Management with Expiration on Server Restart
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: mongoUri, ttl: 30 * 60 }),
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 60 * 1000 // 30 minutes
    }
}));

// SendGrid API Key Setup
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// User Schema
const userSchema = new mongoose.Schema({
    emaildb: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resetKey: { type: String },
    resetExpires: { type: Date },
});
const User = mongoose.model('User', userSchema);

// Token Schema
const tokenSchema = new mongoose.Schema({
    email: { type: String, required: true },
    token: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 3600 },
});
const Token = mongoose.model('Token', tokenSchema);

// Helper Functions
function hashPassword(password) {
    const saltRounds = 10;
    return bcrypt.hashSync(password, saltRounds);
}

function isValidPassword(password) {
    const passwordRegex = /^(?=.*[A-Z])(?=.*\d).{8,}$/;
    return passwordRegex.test(password);
}

function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

async function sendResetCodeEmail(email, resetCode) {
    const msg = {
        to: email,
        from: 'balicweyjohnwell@gmail.com', // Replace with your verified SendGrid email
        subject: 'Your Password Reset Code',
        text: `Your password reset code is: ${resetCode}`,
        html: `<p>Your password reset code is:</p><h3>${resetCode}</h3>`,
    };
    await sgMail.send(msg);
}

// Rate Limiting for Login Route
const loginLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, please try again after 30 minutes.'
});

// Login Route Implementation
app.post('/index', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
        if (!validator.isEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email format.' });

        const user = await User.findOne({ emaildb: email });
        if (!user) return res.status(400).json({ success: false, message: 'Invalid email or password.' });

        if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
            const remainingTime = Math.ceil((user.accountLockedUntil - new Date()) / 60000);
            return res.status(403).json({ success: false, message: `Account is locked. Try again in ${remainingTime} minutes.` });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            let invalidAttempts = (user.invalidLoginAttempts || 0) + 1;
            let updateFields = { invalidLoginAttempts: invalidAttempts };

            if (invalidAttempts >= 3) {
                updateFields.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
                updateFields.invalidLoginAttempts = 0;
                await User.updateOne({ _id: user._id }, { $set: updateFields });
                return res.status(403).json({ success: false, message: 'Account is locked due to multiple failed login attempts. Please try again after 30 minutes.' });
            } else {
                await User.updateOne({ _id: user._id }, { $set: updateFields });
                return res.status(400).json({ success: false, message: 'Invalid email or password.' });
            }
        }

        await User.updateOne(
            { _id: user._id },
            { $set: { invalidLoginAttempts: 0, accountLockedUntil: null, lastLoginTime: new Date() } }
        );

        req.session.userId = user._id;
        req.session.email = user.emaildb;
        req.session.role = user.role;

        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        res.json({ success: true, role: user.role, message: 'Login successful!' });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ success: false, message: 'Error during login.' });
    }
});

// Sign Up Route
app.post('/signup', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
        if (!isValidPassword(password)) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
        }

        const existingUser = await User.findOne({ emaildb: email });
        if (existingUser) return res.status(400).json({ success: false, message: 'Email already registered.' });

        const hashedPassword = hashPassword(password);
        await User.create({ emaildb: email, password: hashedPassword });
        
        res.json({ success: true, message: 'Account created successfully!' });
    } catch (error) {
        console.error('Error creating account:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// Route to fetch user details (email) if authenticated
app.get('/user-details', isAuthenticated, (req, res) => {
    try {
        res.json({ success: true, user: { email: req.session.email } });
    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({ success: false, message: 'Error fetching user details.' });
    }
});

// Middleware for Authentication
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized access.' });
    }
}

// Protected Routes
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

// Forgot Password Route
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json('Email is required');
    }

    try {
        let existingToken = await Token.findOne({ email });
        const resetToken = generateRandomString(32);

        if (existingToken) {
            existingToken.token = resetToken;
            await existingToken.save();
        } else {
            const newToken = new Token({ email, token: resetToken });
            await newToken.save();
        }

        res.status(200).json({ message: 'Password reset token generated and saved' });
    } catch (error) {
        console.error('Error processing forgot-password request:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
});

// Send Password Reset Route
app.post('/send-password-reset', async (req, res) => {
    const { email } = req.body;

    try {
        if (!email) return res.status(400).json({ message: 'Email is required' });

        const user = await User.findOne({ emaildb: email });
        if (!user) {
            return res.status(404).json({ message: 'Email not found' });
        }
        
        const resetCode = generateRandomString(6);
        await sendResetCodeEmail(email, resetCode);
        res.status(200).json({ message: 'Password reset code sent to your email.' });
    } catch (error) {
        console.error('Error sending password reset code:', error);
        res.status(500).json({ message: 'Error sending reset code.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
