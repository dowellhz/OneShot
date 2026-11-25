"""Shared asset records for creative memory integration tests."""

from chat_fixture import ChatFixture


class MemoryFixture(ChatFixture):
    async def create(self, **kw):
        p = {"name": "林森", "kind": "character", "desc": "黑发、圆框眼镜，绿色外套", "board": "test", "ref": self.source["ref"], "source_board": "test", "node_id": "n1", **kw}
        r = await self.client.post('/api/memory', json=p)
        self.assertEqual(r.status, 200, await r.text())
        return await r.json()
