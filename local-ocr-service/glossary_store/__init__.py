from .common import GlossaryBase
from .entries import EntriesMixin
from .libraries import LibrariesMixin
from .pending import PendingMixin
from .transfer import TransferMixin


class GlossaryDB(EntriesMixin, PendingMixin, TransferMixin, LibrariesMixin, GlossaryBase):
    """Persistent glossary storage backed by SQLite."""


__all__ = ["GlossaryDB"]
