import { Router } from 'express';
import { authenticateUser, requireAdmin } from '../middleware/auth.middleware';
import {
  standardLimiter,
  writeLimiter,
  adminLimiter,
  activityLimiter,
} from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createProfileSchema,
  updateProfileSchema,
  createNotificationSettingsSchema,
  updateNotificationSettingsSchema,
  registerDeviceSchema,
  logActivitySchema,
  searchUsernameSchema,
  createAdminUserSchema,
  adminUpdateUserSchema,
} from '../schemas/user.schemas';
import * as UserController from '../controllers/user.controller';

const router = Router();

router.use(authenticateUser as any);

// ─── Own Profile (/users/me) ──────────────────────────────────────────────────
router.get('/me',     standardLimiter,                                    UserController.getMyProfile as any);
router.post('/me',    writeLimiter,    validate(createProfileSchema),     UserController.createMyProfile as any);
router.put('/me',     writeLimiter,    validate(updateProfileSchema),     UserController.updateMyProfile as any);
router.delete('/me',  writeLimiter,                                       UserController.deleteMyAccount as any);

// ─── Own Notification Settings ────────────────────────────────────────────────
router.get('/me/notifications',  standardLimiter,                                              UserController.getMyNotificationSettings as any);
router.post('/me/notifications', writeLimiter,    validate(createNotificationSettingsSchema),  UserController.createMyNotificationSettings as any);
router.put('/me/notifications',  writeLimiter,    validate(updateNotificationSettingsSchema),  UserController.updateMyNotificationSettings as any);

// ─── Own Devices ──────────────────────────────────────────────────────────────
router.get('/me/devices',                standardLimiter,                                 UserController.getMyDevices as any);
router.post('/me/devices',               writeLimiter,    validate(registerDeviceSchema), UserController.registerMyDevice as any);
router.delete('/me/devices/:deviceId',   writeLimiter,                                   UserController.removeMyDevice as any);
router.put('/me/devices/:deviceId/ping', standardLimiter,                                UserController.pingMyDevice as any);

// ─── Own Activity ─────────────────────────────────────────────────────────────
router.get('/me/activity',   standardLimiter,                               UserController.getMyActivity as any);
router.post('/me/activity',  activityLimiter, validate(logActivitySchema),  UserController.logMyActivity as any);

// ─── Public Lookups ───────────────────────────────────────────────────────────
router.get('/search', standardLimiter, validate(searchUsernameSchema, 'query'), UserController.searchProfileByUsername as any);
router.get('/:id',    standardLimiter,                                           UserController.getProfileById as any);

// ─── Admin (/users/admin) ─────────────────────────────────────────────────────
router.get('/admin/users',                adminLimiter, requireAdmin as any,                              UserController.adminGetAllUsers as any);
router.get('/admin/users/:id',            adminLimiter, requireAdmin as any,                              UserController.adminGetUserById as any);
router.post('/admin/users/standard',      adminLimiter, requireAdmin as any, validate(createAdminUserSchema), UserController.adminCreateStandardUser as any);
router.post('/admin/users/admin',         adminLimiter, requireAdmin as any, validate(createAdminUserSchema), UserController.adminCreateAdminUser as any);
router.put('/admin/users/:id',            adminLimiter, requireAdmin as any, validate(adminUpdateUserSchema),  UserController.adminUpdateUser as any);
router.put('/admin/users/:id/pro',        adminLimiter, requireAdmin as any,                              UserController.adminToggleProMember as any);
router.get('/admin/users/:id/activity',   adminLimiter, requireAdmin as any,                              UserController.adminGetUserActivity as any);

export default router;
