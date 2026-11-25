"""Resolve the creative memory store for an authenticated request."""
from __future__ import annotations




def store(req):
    return req.app["creative_memory"]
