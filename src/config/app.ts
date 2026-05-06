import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import userRoutes from '../routes/user.routes';
import cardRoutes from '../routes/card.routes';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(morgan('combined'));

app.use('/api/v1/users', userRoutes);
app.use('/api/v1/cards', cardRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

export default app;
