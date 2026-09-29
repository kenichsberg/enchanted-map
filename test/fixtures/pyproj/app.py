from senders import Sender, SMSSender, EmailSender


def notify(sender: Sender, msg: str) -> None:
    # Dispatch through the declared base type. The language server resolves this
    # to Sender.send, whose outgoing call list is empty, so the concrete
    # implementation is never reached. This is the motivating hole.
    sender.send(msg)


def create_session(user: str) -> None:
    audit("session", user)


def audit(kind: str, user: str) -> None:
    print(kind, user)


def login(user: str, mfa: bool) -> None:
    # unguarded call
    audit("login", user)
    if mfa:
        # single concrete candidate constructed in this flow -> resolvable by
        # the constructor-evidence heuristic
        notify(SMSSender(), "code")
    else:
        create_session(user)
    # second distinct call site to the same callee (audit) from the same caller
    audit("login-done", user)


def broadcast(users: list[str], urgent: bool) -> None:
    for user in users:
        if urgent:
            # nested guards: for -> if
            notify(SMSSender(), "urgent")
        else:
            notify(EmailSender(), "normal")


def ambiguous(flag: bool) -> None:
    # two candidates constructed in the same flow -> heuristic must NOT resolve
    sender = SMSSender() if flag else EmailSender()
    notify(sender, "ambiguous")


def countdown(n: int) -> None:
    # direct recursion: traversal must terminate and mark a cycle
    if n > 0:
        countdown(n - 1)


def ping(n: int) -> None:
    if n > 0:
        pong(n - 1)


def pong(n: int) -> None:
    # mutual recursion
    if n > 0:
        ping(n - 1)
