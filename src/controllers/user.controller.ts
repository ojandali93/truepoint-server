import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as UserService from "../services/user.service";

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
  } catch (err) {
    handleError(res, err);
  }
};

export const createMyProfile = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.createProfile(req.user.id, req.body);
    res.status(201).json({ data: profile });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const deleteMyAccount = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.deleteAccount(req.user.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
};

export const getProfileById = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.getPublicProfile(req.params.id);
    res.json({ data: profile });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const registerMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const device = await UserService.registerDevice(req.user.id, req.body);
    res.status(201).json({ data: device });
  } catch (err) {
    handleError(res, err);
  }
};

export const removeMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.removeDevice(req.params.deviceId, req.user.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const logMyActivity = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await UserService.logActivity(req.user.id, req.body);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const adminGetUserById = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.getProfileById(req.params.id);
    res.json({ data: profile });
  } catch (err) {
    handleError(res, err);
  }
};

export const adminUpdateUser = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const profile = await UserService.adminUpdateUser(req.params.id, req.body);
    res.json({ data: profile });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};
