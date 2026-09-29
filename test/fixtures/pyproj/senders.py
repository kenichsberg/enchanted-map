class Sender:
    def send(self, msg: str) -> None:
        raise NotImplementedError


class SMSSender(Sender):
    def send(self, msg: str) -> None:
        _deliver("sms", msg)


class EmailSender(Sender):
    def send(self, msg: str) -> None:
        _deliver("email", msg)


def _deliver(channel: str, msg: str) -> None:
    print(channel, msg)
