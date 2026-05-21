from __future__ import annotations

from quilin_mem.store import QuilinMemStore


async def test_search_reranks_matching_rows_by_salience_score() -> None:
    async with QuilinMemStore(db_path=":memory:") as store:
        await store.store(
            "ranking needle low salience",
            importance_score=0.2,
            salience={"importance": 0.2, "utility": 0.2, "actionability": 0.2},
        )
        await store.store(
            "ranking needle high salience",
            importance_score=0.2,
            salience={"importance": 0.2, "utility": 1.0, "actionability": 1.0},
        )

        results = await store.search("ranking needle", limit=2)

    assert [item.content for item in results] == [
        "ranking needle high salience",
        "ranking needle low salience",
    ]
