"use server";
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

import { sessions } from "@/session/store";
import { HandlerOptions } from "@redwoodjs/sdk/router";
import { db } from "@/db";
import { verifyTurnstileToken } from "@redwoodjs/sdk/turnstile";

export async function startPasskeyRegistration(
  username: string,
  opts?: HandlerOptions,
) {
  const { headers, env } = opts!;

  const options = await generateRegistrationOptions({
    rpName: env.APP_NAME,
    rpID: env.RP_ID,
    userName: username,
    authenticatorSelection: {
      // Require the authenticator to store the credential, enabling a username-less login experience
      residentKey: "required",
      // Prefer user verification (biometric, PIN, etc.), but allow authentication even if it's not available
      userVerification: "preferred",
    },
  });

  await sessions.save(headers, { challenge: options.challenge });

  return options;
}

export async function finishPasskeyRegistration(
  username: string,
  registration: RegistrationResponseJSON,
  turnstileToken: string,
  opts?: HandlerOptions,
) {
  const { request, headers, env } = opts!;

  if (
    !(await verifyTurnstileToken({
      token: turnstileToken,
      secretKey: env.TURNSTILE_SECRET_KEY,
    }))
  ) {
    return false;
  }

  const { origin } = new URL(request.url);

  const session = await sessions.load(request);
  const challenge = session?.challenge;

  if (!challenge) {
    return false;
  }

  const verification = await verifyRegistrationResponse({
    response: registration,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: env.RP_ID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return false;
  }

  await sessions.save(headers, { challenge: null });

  const user = await db.user.create({
    data: {
      username,
    },
  });

  await db.credential.create({
    data: {
      userId: user.id,
      credentialId: verification.registrationInfo.credential.id,
      publicKey: verification.registrationInfo.credential.publicKey,
      counter: verification.registrationInfo.credential.counter,
    },
  });

  return true;
}

export async function startPasskeyLogin(opts?: HandlerOptions) {
  const { headers, env } = opts!;

  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: "preferred",
    allowCredentials: [],
  });

  await sessions.save(headers, { challenge: options.challenge });

  return options;
}

export async function finishPasskeyLogin(
  login: AuthenticationResponseJSON,
  opts?: HandlerOptions,
) {
  const { request, headers, env } = opts!;
  const { origin } = new URL(request.url);

  const session = await sessions.load(request);
  const challenge = session?.challenge;

  if (!challenge) {
    return false;
  }

  const credential = await db.credential.findUnique({
    where: {
      credentialId: login.id,
    },
  });

  if (!credential) {
    return false;
  }

  const verification = await verifyAuthenticationResponse({
    response: login,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
    credential: {
      id: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
    },
  });

  if (!verification.verified) {
    return false;
  }

  await db.credential.update({
    where: {
      credentialId: login.id,
    },
    data: {
      counter: verification.authenticationInfo.newCounter,
    },
  });

  const user = await db.user.findUnique({
    where: {
      id: credential.userId,
    },
  });

  if (!user) {
    return false;
  }

  await sessions.save(headers, {
    userId: user.id,
    challenge: null,
  });

  return true;
}
