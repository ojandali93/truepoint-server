import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.middleware';
import { standardLimiter, writeLimiter } from '../middleware/rateLimit.middleware';
import * as GLC from '../controllers/gradingLifecycle.controller';

const lifecycleRouter = Router();
lifecycleRouter.use(authenticateUser as any);

lifecycleRouter.get('/submissions',         standardLimiter, GLC.listSubmissions as any);
lifecycleRouter.get('/submissions/summary', standardLimiter, GLC.getSummary as any);
lifecycleRouter.get('/submissions/:id',     standardLimiter, GLC.getOne as any);
lifecycleRouter.post('/submissions',        writeLimiter,    GLC.create as any);
lifecycleRouter.post('/submissions/:id/advance', writeLimiter, GLC.advance as any);
lifecycleRouter.patch('/submissions/:id',   writeLimiter,    GLC.update as any);
lifecycleRouter.delete('/submissions/:id',  writeLimiter,    GLC.remove as any);

export default lifecycleRouter;
