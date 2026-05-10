// src/controllers/gradingLifecycle.controller.ts

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/user.types';
import {
  getSubmissions, getSubmission, createSubmission,
  advanceStatus, updateSubmission, deleteSubmission,
  getPipelineSummary,
} from '../services/gradingLifecycle.service';

const e = (res: Response, err: unknown) => {
  console.error('[GradingLifecycle]', err);
  res.status(500).json({ error: 'Internal server error' });
};

// GET /grading/submissions
export const listSubmissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = req.query.status as any;
    const submissions = await getSubmissions(req.user.id, status);
    res.json({ data: submissions });
  } catch (err) { e(res, err); }
};

// GET /grading/submissions/summary
export const getSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await getPipelineSummary(req.user.id);
    res.json({ data: summary });
  } catch (err) { e(res, err); }
};

// GET /grading/submissions/:id
export const getOne = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const submission = await getSubmission(req.user.id, req.params.id);
    if (!submission) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ data: submission });
  } catch (err) { e(res, err); }
};

// POST /grading/submissions
export const create = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const submission = await createSubmission(req.user.id, req.body);
    res.status(201).json({ data: submission });
  } catch (err) { e(res, err); }
};

// POST /grading/submissions/:id/advance
export const advance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const submission = await advanceStatus(req.user.id, req.params.id, req.body);
    res.json({ data: submission });
  } catch (err) { e(res, err); }
};

// PATCH /grading/submissions/:id
export const update = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const submission = await updateSubmission(req.user.id, req.params.id, req.body);
    res.json({ data: submission });
  } catch (err) { e(res, err); }
};

// DELETE /grading/submissions/:id
export const remove = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await deleteSubmission(req.user.id, req.params.id);
    res.json({ data: { deleted: true } });
  } catch (err) { e(res, err); }
};