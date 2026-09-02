# Licensing

## Short version

- **nomploy as a whole is licensed under the GNU AGPL-3.0** — see [`LICENSE`](LICENSE).
- **Portions derived from [Dokploy](https://github.com/dokploy/dokploy) remain under Apache-2.0** — see [`LICENSE-APACHE`](LICENSE-APACHE) and [`NOTICE`](NOTICE).

## What this means

nomploy is a fork of Dokploy. Dokploy's code is Apache-2.0 (a permissive
license), and Apache-2.0 explicitly allows redistributing a modified work under
a compatible copyleft license. nomploy therefore licenses the **combined work**,
and all of its own modifications and additions, under the **AGPL-3.0**.

The Apache-2.0 grant on the upstream Dokploy code is **not** removed — it is
preserved (its notices are retained, per Apache-2.0 §4). Anyone can still obtain
that upstream code from Dokploy under Apache-2.0. What is offered under AGPL-3.0
is *this project as a whole*.

### Practical effects

- You may use, self-host, modify and redistribute nomploy under the AGPL-3.0.
- If you run a **modified** nomploy as a network service, the AGPL requires you
  to offer that modified source to your users.
- You do **not** need to add a license header to every file. The repository-level
  `LICENSE`, `LICENSE-APACHE` and `NOTICE` govern the whole tree.

## Commercial licensing

If you want to use nomploy in a way that the AGPL-3.0 does not permit (for
example, embedding it in a proprietary/closed product), a separate commercial
license may be available from the nomploy maintainers. Contributions are accepted
under the [Contributor License Agreement](CLA.md), which keeps this option open.
