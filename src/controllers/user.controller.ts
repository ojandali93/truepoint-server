import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as UserService from "../services/user.service";
import { logError } from "../lib/Logger";

const handleError = (res: Response, err: any) => {
  if (err?.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[UserController Error]", err?.message ?? err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// ─── Profile ─────────────────────────────────────────────────────────────────

export const getMyProfile = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.getProfileById(req.user.id);
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "get-my-profile", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const createMyProfile = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.createProfile(req.user.id, req.body);
    res.status(201).json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "create-my-profile", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const updateMyProfile = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    console.log("updateMyProfile pre", req.body);
    const profile = await UserService.updateProfile(req.user.id, req.body);
    console.log("updateMyProfile post", profile);
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "inventory", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const deleteMyAccount = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.deleteAccount(req.user.id);
    res.status(204).send();
  } catch (err: any) {
    await logError({
      source: "delete-my-account", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getProfileById = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.getPublicProfile(req.params.id);
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "get-profile-by-id", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const searchProfileByUsername = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.searchByUsername(
      req.query.username as string,
    );
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "search-profile-by-username", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Notification Settings ────────────────────────────────────────────────────

export const getMyNotificationSettings = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const settings = await UserService.getNotificationSettings(req.user.id);
    res.json({ data: settings });
  } catch (err: any) {
    await logError({
      source: "get-my-notification-settings", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const createMyNotificationSettings = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const settings = await UserService.createNotificationSettings(
      req.user.id,
      req.body,
    );
    res.status(201).json({ data: settings });
  } catch (err: any) {
    await logError({
      source: "create-my-notification-settings", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const updateMyNotificationSettings = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const settings = await UserService.updateNotificationSettings(
      req.user.id,
      req.body,
    );
    res.json({ data: settings });
  } catch (err: any) {
    await logError({
      source: "update-my-notification-settings", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Devices ──────────────────────────────────────────────────────────────────

export const getMyDevices = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const devices = await UserService.getDevices(req.user.id);
    res.json({ data: devices });
  } catch (err: any) {
    await logError({
      source: "get-my-devices", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const registerMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const device = await UserService.registerDevice(req.user.id, req.body);
    res.status(201).json({ data: device });
  } catch (err: any) {
    await logError({
      source: "register-my-device", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const removeMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.removeDevice(req.params.deviceId, req.user.id);
    res.status(204).send();
  } catch (err: any) {
    await logError({
      source: "remove-my-device", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const pingMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const device = await UserService.pingDevice(
      req.params.deviceId,
      req.user.id,
    );
    res.json({ data: device });
  } catch (err: any) {
    await logError({
      source: "ping-my-device", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Activity ─────────────────────────────────────────────────────────────────

export const getMyActivity = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const logs = await UserService.getActivityLogs(req.user.id, page);
    res.json({ data: logs });
  } catch (err: any) {
    await logError({
      source: "get-my-activity", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const logMyActivity = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.logActivity(req.user.id, req.body);
    res.status(204).send();
  } catch (err: any) {
    await logError({
      source: "log-my-activity", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Admin ────────────────────────────────────────────────────────────────────

export const adminGetAllUsers = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const users = await UserService.adminGetAllUsers(page);
    res.json({ data: users });
  } catch (err: any) {
    await logError({
      source: "admin-get-all-users", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminGetUserById = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.getProfileById(req.params.id);
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "admin-get-user-by-id", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminUpdateUser = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.adminUpdateUser(req.params.id, req.body);
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "admin-update-user", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminCreateStandardUser = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { email, password, username, full_name } = req.body;
    const result = await UserService.adminCreateStandardUser(
      email,
      password,
      username,
      full_name,
    );
    res.status(201).json({ data: result });
  } catch (err: any) {
    await logError({
      source: "admin-create-standard-user", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminCreateAdminUser = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { email, password, username, full_name } = req.body;
    const result = await UserService.adminCreateAdminUser(
      email,
      password,
      username,
      full_name,
    );
    res.status(201).json({ data: result });
  } catch (err: any) {
    await logError({
      source: "admin-create-admin-user", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminToggleProMember = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const isPro = req.body.is_pro_member as boolean;
    const profile = await UserService.adminToggleProMember(
      req.params.id,
      isPro,
    );
    res.json({ data: profile });
  } catch (err: any) {
    await logError({
      source: "admin-toggle-pro-member", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminGetUserActivity = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const logs = await UserService.getActivityLogs(req.params.id, page);
    res.json({ data: logs });
  } catch (err: any) {
    await logError({
      source: "admin-get-user-activity", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};
