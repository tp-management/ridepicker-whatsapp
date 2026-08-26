import express from "express";

import { authenticateRequest } from "./apiSecurity.js";
import { repository } from "./repository.js";
import { selectRows, updateRows } from "./supabase.js";
import { normalizePhoneE164 } from "./utils.js";

const router = express.Router();

function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function sendError(res, error, req = null) {
  const status = error?.status || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({
    error: error?.message || "Unexpected error",
    ...(error?.details ? { details: error.details } : {}),
    ...(req?.requestId ? { requestId: req.requestId } : {}),
  });
}

async function requireAuthenticated(req, res, next) {
  try {
    req.authUser = await authenticateRequest(req);
    return next();
  } catch (error) {
    return sendError(res, error, req);
  }
}

function first(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function linkedRowForAuthUser(authUserId, select = selectRows) {
  return first(
    await select("users", {
      select: "*",
      auth_user_id: `eq.${authUserId}`,
      limit: 1,
    })
  );
}

async function rowForPhone(phone, select = selectRows) {
  return first(
    await select("users", {
      select: "*",
      phone_e164: `eq.${phone}`,
      limit: 1,
    })
  );
}

function verifiedAuthPhone(authUser) {
  if (!authUser?.phone || !authUser?.phone_confirmed_at) {
    throw httpError(403, "verified phone authentication is required", {
      code: "verified_phone_required",
    });
  }

  return normalizePhoneE164(authUser.phone);
}

export async function bootstrapRidePickerUser({
  authUser,
  name = null,
  select = selectRows,
  update = updateRows,
  coreRepository = repository,
} = {}) {
  if (!authUser?.id) {
    throw httpError(401, "authentication required");
  }

  const linked = await linkedRowForAuthUser(authUser.id, select);
  if (linked) {
    return {
      created: false,
      user: await coreRepository.getUserById(linked.id),
    };
  }

  const authPhone = verifiedAuthPhone(authUser);
  const existing = await rowForPhone(authPhone, select);

  if (existing) {
    if (
      existing.auth_user_id &&
      String(existing.auth_user_id) !== String(authUser.id)
    ) {
      throw httpError(
        409,
        "This phone number is already linked to another account",
        { code: "phone_already_linked" }
      );
    }

    if (!existing.auth_user_id) {
      const updated = await update(
        "users",
        { auth_user_id: authUser.id },
        {
          id: `eq.${existing.id}`,
          auth_user_id: "is.null",
        }
      );

      if (!first(updated)) {
        const currentForAuth = await linkedRowForAuthUser(authUser.id, select);
        if (currentForAuth?.id === existing.id) {
          return {
            created: false,
            user: await coreRepository.getUserById(existing.id),
          };
        }

        const currentForPhone = await rowForPhone(authPhone, select);
        if (
          currentForPhone?.auth_user_id &&
          String(currentForPhone.auth_user_id) !== String(authUser.id)
        ) {
          throw httpError(
            409,
            "This phone number is already linked to another account",
            { code: "phone_already_linked" }
          );
        }

        throw httpError(409, "Could not link the authenticated account", {
          code: "account_link_conflict",
        });
      }
    }

    return {
      created: false,
      user: await coreRepository.getUserById(existing.id),
    };
  }

  const cleanName = String(name || "").trim();
  if (!cleanName) {
    throw httpError(409, "Profile setup is required", {
      code: "profile_required",
    });
  }

  const created = await coreRepository.createUser({
    name: cleanName,
    phone: authPhone,
    email: authUser.email || null,
  });

  const updated = await update(
    "users",
    { auth_user_id: authUser.id },
    {
      id: `eq.${created.id}`,
      auth_user_id: "is.null",
    }
  );

  if (!first(updated)) {
    const currentForAuth = await linkedRowForAuthUser(authUser.id, select);
    if (currentForAuth) {
      return {
        created: false,
        user: await coreRepository.getUserById(currentForAuth.id),
      };
    }

    const currentForPhone = await rowForPhone(authPhone, select);
    if (
      currentForPhone?.auth_user_id &&
      String(currentForPhone.auth_user_id) !== String(authUser.id)
    ) {
      throw httpError(
        409,
        "This phone number is already linked to another account",
        { code: "phone_already_linked" }
      );
    }

    throw httpError(409, "Could not link the new account to authentication", {
      code: "account_link_conflict",
    });
  }

  return {
    created: true,
    user: await coreRepository.getUserById(created.id),
  };
}

router.post("/api/auth/bootstrap", requireAuthenticated, async (req, res) => {
  try {
    const result = await bootstrapRidePickerUser({
      authUser: req.authUser,
      name: req.body?.name || null,
    });

    return res.status(result.created ? 201 : 200).json({
      user: result.user,
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  } catch (error) {
    return sendError(res, error, req);
  }
});

export default router;
