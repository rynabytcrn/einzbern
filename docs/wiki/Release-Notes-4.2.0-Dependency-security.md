# Einzbern 4.2.0 — Dependency security

- Upgrade the exact Ajv transitive dependency fast-uri from 3.1.8 to 3.1.9,
  addressing GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h,
  GHSA-wjr9-j795-jxcr and GHSA-333x-w4r6-6crp. Retain the frozen graph and
  verified package integrity; exercise malformed schemes/hosts, relative and
  suffix references, and Ajv schema reference resolution.

[Version directory](Release-Notes-4.2.0.md) | [Principles and portable installation](Release-Notes-4.2.0-Principles-and-portable-installation.md)
